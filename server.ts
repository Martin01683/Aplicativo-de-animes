import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import type { SnapshotAssetReader } from './src/lib/catalog/serverCatalog.ts';
import type { HttpFetcher } from './src/lib/httpTypes.ts';
import { dispatchAnisyncApiRequest } from './src/lib/anisyncApiRouter.ts';
import {
  adjustContentRangeForStrip,
  findMpegTsSyncOffset,
  isDisguisedContentType,
  isStartAtZeroRange,
  looksLikeM3u8Manifest,
  TS_PROBE_BUFFER_SIZE,
} from './src/lib/mpegTsUnmask.ts';
import type { CatalogPreferences, VlcPlaylistEntry } from './src/lib/types.ts';
import { isPrivateOrReservedIp, isSafeExternalHttpUrl } from './src/lib/urlSafety.ts';
import { buildM3uPlaylist, DEFAULT_BROWSER_UA, sanitizeFilename } from './src/lib/vlc.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_STREAM_REFERER = 'https://topanimes.net/';

const ALLOWED_CUSTOM_HEADERS = new Set([
  'authorization',
  'origin',
  'cookie',
]);

async function assertPublicTarget(rawUrl: string): Promise<URL> {
  if (!isSafeExternalHttpUrl(rawUrl)) {
    throw new Error('URL externa inválida ou bloqueada por segurança.');
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('Endereço IP privado bloqueado.');
    }
    return parsed;
  }

  const records = await dns.lookup(host, { all: true });
  if (!records.length) {
    throw new Error('Não foi possível resolver o host remoto.');
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('Host resolve para endereço IP privado bloqueado.');
    }
  }
  return parsed;
}

async function safeFetch(
  rawUrl: string,
  options: {
    referer?: string;
    range?: string;
    accept?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    method?: 'GET' | 'POST' | 'PROPFIND';
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<globalThis.Response> {
  let currentUrl = rawUrl;
  let currentMethod: 'GET' | 'POST' | 'PROPFIND' =
    options.method === 'POST'
      ? 'POST'
      : options.method === 'PROPFIND'
        ? 'PROPFIND'
        : 'GET';
  let currentBody = currentMethod === 'POST' ? options.body : undefined;
  const maxRedirects = 4;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const validated = await assertPublicTarget(currentUrl);
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_BROWSER_UA,
      Accept: options.accept || 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    };

    const isFileVideo = /filevideo1\.com/i.test(validated.hostname);
    const isTikTokCdn = /(?:^|\.)tiktokcdn\.com$/i.test(validated.hostname);
    if (
      options.referer &&
      isSafeExternalHttpUrl(options.referer) &&
      !(isFileVideo && /csst\.online/i.test(options.referer)) &&
      !isTikTokCdn
    ) {
      headers.Referer = options.referer;
    }
    if (options.range && currentMethod === 'GET') {
      headers.Range = options.range;
    }
    if (currentMethod === 'POST') {
      const ct = options.contentType || 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Type'] = ct;
      if (!/application\/json/i.test(ct)) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
      }
    }
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        if (ALLOWED_CUSTOM_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && v.trim()) {
          headers[k] = v.trim();
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new Error('Conexão cancelada.');
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let res: globalThis.Response;
    try {
      res = await fetch(validated.href, {
        method: currentMethod,
        headers,
        body: currentMethod === 'POST' ? currentBody : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      if (res.status !== 307 && res.status !== 308 && currentMethod === 'POST') {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = new URL(loc, validated.href).href;
      continue;
    }

    return res;
  }

  throw new Error('Excesso de redirecionamentos ao acessar fonte externa.');
}

const nodeHttpFetcher: HttpFetcher = async (url, options = {}) => {
  const res = await safeFetch(url, {
    method: options.method,
    referer: options.referer,
    accept: options.accept,
    contentType: options.contentType,
    body: options.body,
    headers: options.headers,
    timeoutMs: options.timeoutMs,
  });
  const body = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    finalUrl: res.url || url,
    body,
  };
};

function decodeCatalogPrefsHeader(req: Request): CatalogPreferences | undefined {
  const raw = req.header('x-anisync-catalog-config');
  if (!raw || raw.length > 8192) return undefined;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as CatalogPreferences;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // ignore malformed header
  }
  return undefined;
}

const nodeSnapshotReader: SnapshotAssetReader = async (assetFileName: string) => {
  const safeName = path.basename(assetFileName);
  const fullPath = path.join(__dirname, 'public/assets/aistudio', safeName);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
};

const DIRECT_SEGMENT_HOSTS_RE =
  /(?:^|\.)(?:tiktokcdn\.com|booonceivu\.shop|123flmsfree\.com|321moviesfree\.com)$/i;

function rewriteM3u8Playlist(manifest: string, baseManifestUrl: string, referer: string): string {
  const lines = manifest.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_, rawUri: string) => {
          try {
            const abs = new URL(rawUri, baseManifestUrl).href;
            if (!isSafeExternalHttpUrl(abs)) return `URI="${rawUri}"`;
            if (DIRECT_SEGMENT_HOSTS_RE.test(new URL(abs).hostname)) return `URI="${abs}"`;
            const proxied = `/api/stream-proxy?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
            return `URI="${proxied}"`;
          } catch {
            return `URI="${rawUri}"`;
          }
        });
      }

      try {
        const abs = new URL(trimmed, baseManifestUrl).href;
        if (!isSafeExternalHttpUrl(abs)) return line;
        if (DIRECT_SEGMENT_HOSTS_RE.test(new URL(abs).hostname)) return abs;
        const isNestedPlaylist = /\.m3u8(?:$|\?)/i.test(abs);
        return `/api/stream-proxy?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}${isNestedPlaylist ? '' : '&hls_seg=1'}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

async function createAppServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const anisyncApkPath = path.join(__dirname, 'downloads/Anisync.apk');
  const legacyApkPath = path.join(__dirname, 'downloads/TopAnimes.apk');

  const resolveAvailableApk = (): { filePath: string; filename: string; url: string } | null => {
    if (fs.existsSync(anisyncApkPath)) {
      return { filePath: anisyncApkPath, filename: 'Anisync.apk', url: '/downloads/Anisync.apk' };
    }
    if (fs.existsSync(legacyApkPath)) {
      return { filePath: legacyApkPath, filename: 'TopAnimes.apk', url: '/downloads/TopAnimes.apk' };
    }
    return null;
  };

  app.get('/api/apk-info', (_req: Request, res: Response) => {
    const found = resolveAvailableApk();
    if (found) {
      const stat = fs.statSync(found.filePath);
      res.json({
        available: true,
        url: found.url,
        filename: found.filename,
        sizeBytes: stat.size,
      });
      return;
    }
    res.json({ available: false });
  });

  app.get(['/downloads/Anisync.apk', '/downloads/TopAnimes.apk'], (_req: Request, res: Response) => {
    const found = resolveAvailableApk();
    if (!found) {
      res.status(404).send('APK ainda não foi gerado.');
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${found.filename}"`);
    res.sendFile(found.filePath);
  });

  // Unified Anisync Aggregator API routes
  const handleAggregatedRoute = async (req: Request, res: Response) => {
    const catalogPrefs = decodeCatalogPrefsHeader(req);
    const result = await dispatchAnisyncApiRequest(
      req.originalUrl,
      {
        method: req.method,
        jsonBody: req.method === 'POST' ? req.body : undefined,
      },
      {
        fetchHttp: nodeHttpFetcher,
        serviceName: 'anisync',
        catalogPrefs,
        snapshotReader: nodeSnapshotReader,
        useCache: true,
      }
    );
    res.status(result.status).json(result.body);
  };

  app.get('/api/health', handleAggregatedRoute);
  app.get('/api/app-update/check', handleAggregatedRoute);
  app.get('/api/home', handleAggregatedRoute);
  app.get('/api/calendar', handleAggregatedRoute);
  app.get('/api/episodes', handleAggregatedRoute);
  app.get('/api/catalog', handleAggregatedRoute);
  app.get('/api/glossary', handleAggregatedRoute);
  app.get('/api/search-suggest', handleAggregatedRoute);
  app.get('/api/search', handleAggregatedRoute);
  app.get('/api/random', handleAggregatedRoute);
  app.get('/api/anime', handleAggregatedRoute);
  app.get('/api/media', handleAggregatedRoute);
  app.post('/api/favorites/check', handleAggregatedRoute);
  app.get('/api/episode', handleAggregatedRoute);
  app.post('/api/episode', handleAggregatedRoute);
  app.post('/api/sources/resolve', handleAggregatedRoute);
  app.post('/api/sources/test', handleAggregatedRoute);
  app.get('/api/resolve-embed', handleAggregatedRoute);
  app.post('/api/resolve-embed', handleAggregatedRoute);

  app.get('/api/playlist.m3u', (req: Request, res: Response) => {
    const streamUrl = String(req.query.streamUrl || '').trim();
    const title = String(req.query.title || 'Anisync').trim();
    const referer = String(req.query.referer || DEFAULT_STREAM_REFERER).trim();
    const subtitleUrl = String(req.query.subtitleUrl || '').trim();

    if (!isSafeExternalHttpUrl(streamUrl)) {
      res.status(400).json({ error: 'URL de stream inválida.' });
      return;
    }

    const content = buildM3uPlaylist([
      {
        title,
        streamUrl,
        referer: isSafeExternalHttpUrl(referer) ? referer : DEFAULT_STREAM_REFERER,
        subtitleUrl: isSafeExternalHttpUrl(subtitleUrl) ? subtitleUrl : undefined,
      },
    ]);

    const filename = `${sanitizeFilename(title)}.m3u`;
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  });

  app.post('/api/playlist.m3u', (req: Request, res: Response) => {
    const body = req.body as { filename?: string; entries?: VlcPlaylistEntry[] };
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    const safeEntries = entries.filter((e) => e && isSafeExternalHttpUrl(e.streamUrl));

    if (!safeEntries.length) {
      res.status(400).json({ error: 'Nenhuma URL de stream válida enviada para a playlist.' });
      return;
    }

    const content = buildM3uPlaylist(safeEntries);
    const filename = `${sanitizeFilename(body?.filename || 'playlist_anisync')}.m3u`;
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  });

  const PROXY_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

  app.get('/api/stream-proxy', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '').trim();
    const refererParam = String(req.query.referer || DEFAULT_STREAM_REFERER).trim();
    const referer = isSafeExternalHttpUrl(refererParam) ? refererParam : DEFAULT_STREAM_REFERER;
    const isDownload = String(req.query.download || '') === '1';
    const isHlsSegment = String(req.query.hls_seg || '') === '1';

    if (!isSafeExternalHttpUrl(targetUrl)) {
      res.status(400).send('URL inválida');
      return;
    }

    const streamAbort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) streamAbort.abort();
    });

    try {
      let rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      if (!isDownload && rangeHeader) {
        const rangeMatch = rangeHeader.match(/^bytes=(\d+)-(\d*)$/i);
        if (rangeMatch) {
          const start = Number.parseInt(rangeMatch[1], 10);
          const rawEnd = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : null;
          const maxEnd = start + PROXY_RANGE_CHUNK_BYTES - 1;
          const clampedEnd = rawEnd === null ? maxEnd : Math.min(rawEnd, maxEnd);
          rangeHeader = `bytes=${start}-${clampedEnd}`;
        }
      }

      const upstream = await safeFetch(targetUrl, {
        referer,
        range: rangeHeader,
        accept: '*/*',
        timeoutMs: 20000,
        signal: streamAbort.signal,
      });

      const contentType = upstream.headers.get('content-type') || '';
      const isPlaylist =
        /mpegurl|m3u8/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(targetUrl);

      if (isPlaylist && upstream.ok) {
        const text = await upstream.text();
        const rewritten = rewriteM3u8Playlist(text, upstream.url || targetUrl, referer);
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewritten);
        return;
      }

      const shouldProbeTs =
        upstream.ok &&
        !isDownload &&
        Boolean(upstream.body) &&
        isStartAtZeroRange(rangeHeader) &&
        (isHlsSegment || isDisguisedContentType(contentType));

      if (shouldProbeTs && upstream.body) {
        const reader = upstream.body.getReader();
        const onAbort = () => {
          reader.cancel().catch(() => {});
        };
        streamAbort.signal.addEventListener('abort', onAbort, { once: true });

        try {
          const probeChunks: Buffer[] = [];
          let bufferedLen = 0;
          let reachedEof = false;

          while (bufferedLen < TS_PROBE_BUFFER_SIZE) {
            const { done, value } = await reader.read();
            if (done) {
              reachedEof = true;
              break;
            }
            if (value && value.byteLength > 0) {
              const chunkBuf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
              probeChunks.push(chunkBuf);
              bufferedLen += chunkBuf.length;
            }
          }

          const initialBuf = Buffer.concat(probeChunks, bufferedLen);

          if (looksLikeM3u8Manifest(initialBuf, Math.min(initialBuf.length, TS_PROBE_BUFFER_SIZE))) {
            const restChunks: Buffer[] = [initialBuf];
            if (!reachedEof) {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                  restChunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
                }
              }
            }
            const rawManifest = Buffer.concat(restChunks).toString('utf8');
            const rewritten = rewriteM3u8Playlist(rawManifest, upstream.url || targetUrl, referer);
            res.status(200);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(rewritten);
            return;
          }

          const tsOffset = findMpegTsSyncOffset(initialBuf, initialBuf.length, reachedEof);
          let outStatus = upstream.status;
          let outContentType = contentType || 'application/octet-stream';
          const rawLength = upstream.headers.get('content-length');
          let outContentLength = rawLength ? Number.parseInt(rawLength, 10) : -1;
          if (!Number.isFinite(outContentLength)) outContentLength = -1;
          let outContentRange = upstream.headers.get('content-range');
          let outAcceptRanges = upstream.headers.get('accept-ranges');

          if (tsOffset >= 0) {
            outContentType = 'video/mp2t';
            if (tsOffset > 0) {
              if (outContentLength >= tsOffset) {
                outContentLength -= tsOffset;
              } else if (outContentLength >= 0) {
                outContentLength = -1;
              }
              if (outStatus === 206) {
                const adjusted = adjustContentRangeForStrip(outContentRange, tsOffset);
                if (adjusted) {
                  outContentRange = adjusted;
                } else {
                  outStatus = 200;
                  outContentRange = null;
                }
              }
              outAcceptRanges = null;
            }
          }

          res.status(outStatus);
          res.setHeader('Content-Type', outContentType);
          if (outContentLength >= 0) res.setHeader('Content-Length', String(outContentLength));
          if (outContentRange) res.setHeader('Content-Range', outContentRange);
          if (outAcceptRanges) res.setHeader('Accept-Ranges', outAcceptRanges);
          res.setHeader('Access-Control-Allow-Origin', '*');

          const firstSlice = tsOffset > 0 ? initialBuf.subarray(tsOffset) : initialBuf;
          if (firstSlice.length > 0 && !res.write(firstSlice)) {
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }

          if (!reachedEof) {
            while (!streamAbort.signal.aborted && !res.writableEnded) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                if (!res.write(buf)) {
                  await new Promise<void>((resolve) => res.once('drain', resolve));
                }
              }
            }
          }
          if (!res.writableEnded) res.end();
          return;
        } finally {
          streamAbort.signal.removeEventListener('abort', onAbort);
          reader.releaseLock();
        }
      }

      res.status(upstream.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (isDownload) {
        res.setHeader('Content-Disposition', 'attachment');
      }

      if (!upstream.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
      nodeStream.on('error', () => {
        if (!res.headersSent) res.status(502);
        res.end();
      });
      nodeStream.pipe(res);
    } catch (err) {
      if (!res.headersSent && !streamAbort.signal.aborted) {
        res.status(502).send(err instanceof Error ? err.message : 'Erro no proxy de mídia');
      }
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: !disableHmr,
        ws: disableHmr ? false : { server: httpServer },
      },
      appType: 'custom',
    });
    app.use(vite.middlewares);

    app.use(async (req: Request, res: Response, next) => {
      if (req.originalUrl.startsWith('/api/')) {
        next();
        return;
      }
      try {
        const templatePath = path.resolve(__dirname, 'index.html');
        let html = fs.readFileSync(templatePath, 'utf-8');
        html = await vite.transformIndexHtml(req.originalUrl, html);
        if (disableHmr) {
          html = html.replace(/<script\s+type="module"\s+src="\/@vite\/client"><\/script>\s*/i, '');
        }
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Anisync server running on http://0.0.0.0:${PORT}`);
  });
}

createAppServer().catch((err) => {
  console.error('Failed to start Anisync server:', err);
  process.exit(1);
});
