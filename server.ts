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
import { mergeForwardedHeaders } from './src/lib/forwardedHeaders.ts';
import { createResilientHttpFetcher } from './src/lib/hostResilience.ts';
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
import {
  downloadWithServerAria2OrParallel,
  getServerDownloadEnginesStatus,
  resolveEmbedWithServerYtDlp,
} from './src/lib/serverDownloadEngines.ts';
import {
  controlServerTvCast,
  convertSrtToVtt,
  discoverLanTvDevices,
  getCachedLanTvDevices,
  getServerCastSessionByToken,
  getServerCastState,
  prepareServerLanLink,
  rewriteM3u8ForServerLanProxy,
  startServerTvCast,
  stopServerTvCast,
} from './src/lib/serverTvCast.ts';
import type { TvCastDeliveryPreference, TvCastDevice, TvCastMediaPayload } from './src/lib/tvCast.ts';
import { buildM3uPlaylist, DEFAULT_BROWSER_UA, sanitizeFilename } from './src/lib/vlc.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_STREAM_REFERER = 'https://topanimes.net/';

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
    mergeForwardedHeaders(headers, options.headers, validated.hostname);

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

const rawNodeHttpFetcher: HttpFetcher = async (url, options = {}) => {
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
  const retryAfter = res.headers.get('retry-after') || undefined;
  return {
    status: res.status,
    ok: res.ok,
    finalUrl: res.url || url,
    body,
    ...(retryAfter ? { retryAfter } : {}),
  };
};

const nodeHttpFetcher: HttpFetcher = createResilientHttpFetcher(rawNodeHttpFetcher);

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
  const fullPath = path.join(__dirname, 'tests/fixtures/topanimes', safeName);
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
  app.get('/api/episode-synopsis', handleAggregatedRoute);
  app.get('/api/episode-titles', handleAggregatedRoute);
  app.get('/api/anime-synopsis', handleAggregatedRoute);
  app.post('/api/sources/resolve', handleAggregatedRoute);
  app.post('/api/sources/test', handleAggregatedRoute);
  app.get('/api/resolve-embed', handleAggregatedRoute);
  app.post('/api/resolve-embed', handleAggregatedRoute);

  // ---------------------------------------------------------------------------
  // High-Speed Download Engines (aria2c max-connections + yt-dlp fallback)
  // ---------------------------------------------------------------------------

  app.get('/api/download-engines/status', async (_req: Request, res: Response) => {
    try {
      const info = await getServerDownloadEnginesStatus();
      res.json(info);
    } catch (err) {
      res.status(500).json({
        aria2Available: false,
        ytdlpAvailable: false,
        error: err instanceof Error ? err.message : 'Falha ao consultar motores de download.',
      });
    }
  });

  app.post('/api/download-engines/resolve-embed', async (req: Request, res: Response) => {
    const body = (req.body || {}) as { embedUrl?: string; referer?: string };
    const embedUrl = String(body.embedUrl || '').trim();
    const referer = String(body.referer || DEFAULT_STREAM_REFERER).trim();
    try {
      await assertPublicTarget(embedUrl);
      const resolved = await resolveEmbedWithServerYtDlp(embedUrl, referer);
      res.status(resolved.ok ? 200 : 422).json(resolved);
    } catch (err) {
      res.status(400).json({
        ok: false,
        streams: [],
        subtitles: [],
        referer,
        errorMessage: err instanceof Error ? err.message : 'URL inválida.',
      });
    }
  });

  app.get('/api/download-engines/fast-download', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '').trim();
    const refererParam = String(req.query.referer || DEFAULT_STREAM_REFERER).trim();
    const referer = isSafeExternalHttpUrl(refererParam) ? refererParam : DEFAULT_STREAM_REFERER;

    const dlAbort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) dlAbort.abort();
    });

    try {
      await assertPublicTarget(targetUrl);
      const result = await downloadWithServerAria2OrParallel({
        url: targetUrl,
        referer,
        signal: dlAbort.signal,
      });

      res.status(200);
      res.setHeader('Content-Type', result.contentType || 'video/mp4');
      if (result.sizeBytes > 0) {
        res.setHeader('Content-Length', String(result.sizeBytes));
      }
      res.setHeader('X-Anisync-Download-Engine', result.engine);
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = fs.createReadStream(result.filePath);
      const cleanupOnce = (() => {
        let done = false;
        return () => {
          if (done) return;
          done = true;
          result.cleanup();
        };
      })();
      stream.on('close', cleanupOnce);
      stream.on('error', () => {
        cleanupOnce();
        if (!res.headersSent) res.status(502);
        res.end();
      });
      res.on('close', () => {
        stream.destroy();
        cleanupOnce();
      });
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent && !dlAbort.signal.aborted) {
        res.status(502).send(err instanceof Error ? err.message : 'Falha no download acelerado.');
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Automatic Wi-Fi TV Discovery & Casting (Chromecast / Android TV + DLNA)
  // ---------------------------------------------------------------------------

  app.get('/api/tv-cast/discover', async (req: Request, res: Response) => {
    const rawTimeout = Number.parseInt(String(req.query.timeoutMs || '3600'), 10);
    const timeoutMs = Number.isFinite(rawTimeout) ? rawTimeout : 3600;
    try {
      const devices = await discoverLanTvDevices(timeoutMs);
      res.json({ supported: true, devices });
    } catch (err) {
      res.status(500).json({
        supported: true,
        devices: getCachedLanTvDevices(),
        error: err instanceof Error ? err.message : 'Falha ao buscar TVs no Wi-Fi.',
      });
    }
  });

  app.get('/api/tv-cast/state', (_req: Request, res: Response) => {
    res.json({ supported: true, state: getServerCastState() });
  });

  app.post('/api/tv-cast/start', async (req: Request, res: Response) => {
    const body = (req.body || {}) as {
      device?: TvCastDevice;
      media?: TvCastMediaPayload;
      deliveryMode?: TvCastDeliveryPreference;
    };
    if (!body.device || !body.media) {
      res.status(400).json({ error: 'Dispositivo de TV e mídia são obrigatórios.' });
      return;
    }
    try {
      const state = await startServerTvCast({
        device: body.device,
        media: body.media,
        serverPort: PORT,
        deliveryMode: body.deliveryMode || 'auto',
      });
      res.json({ started: true, state });
    } catch (err) {
      res.status(502).json({
        started: false,
        error: err instanceof Error ? err.message : 'Não foi possível iniciar a transmissão na TV.',
      });
    }
  });

  app.post('/api/tv-cast/control', async (req: Request, res: Response) => {
    const body = (req.body || {}) as {
      action?: 'play' | 'pause' | 'toggle' | 'seek' | 'seekBy' | 'volume';
      positionMs?: number;
      deltaMs?: number;
      volume?: number;
    };
    if (!body.action) {
      res.status(400).json({ error: 'Ação de controle obrigatória.' });
      return;
    }
    try {
      const state = await controlServerTvCast({
        action: body.action,
        positionMs: body.positionMs,
        deltaMs: body.deltaMs,
        volume: body.volume,
      });
      res.json({ ok: true, state });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Falha ao enviar comando para a TV.',
      });
    }
  });

  app.post('/api/tv-cast/stop', async (_req: Request, res: Response) => {
    const state = await stopServerTvCast();
    res.json({ ok: true, state });
  });

  app.post('/api/tv-cast/prepare-link', (req: Request, res: Response) => {
    const body = (req.body || {}) as { media?: TvCastMediaPayload };
    if (!body.media?.streamUrl) {
      res.status(400).json({ error: 'Stream obrigatório.' });
      return;
    }
    const prepared = prepareServerLanLink(body.media, PORT);
    res.json({ ...prepared, opened: false });
  });

  app.options('/api/tv-cast/media/:token/:asset', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.status(204).end();
  });

  app.get('/api/tv-cast/media/:token/:asset', async (req: Request, res: Response) => {
    const token = String(req.params.token || '');
    const asset = String(req.params.asset || '');
    const session = getServerCastSessionByToken(token);
    if (!session) {
      res.status(403).send('Sessão de transmissão inválida ou encerrada.');
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader(
      'contentFeatures.dlna.org',
      'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'
    );

    const streamAbort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) streamAbort.abort();
    });

    if (asset === 'subtitle.vtt') {
      if (!session.subtitleUrl || !isSafeExternalHttpUrl(session.subtitleUrl)) {
        res.status(404).send('Legenda indisponível');
        return;
      }
      try {
        const subRes = await safeFetch(session.subtitleUrl, {
          referer: session.referer,
          accept: 'text/vtt,text/plain,*/*',
          timeoutMs: 10000,
          signal: streamAbort.signal,
        });
        if (!subRes.ok) {
          res.status(404).send('Legenda indisponível');
          return;
        }
        const vtt = convertSrtToVtt(await subRes.text());
        res.status(200);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.send(vtt);
      } catch {
        if (!res.headersSent) res.status(502).send('Erro ao carregar legenda');
      }
      return;
    }

    const targetUrl = String(req.query.url || session.streamUrl || '').trim();
    const refererParam = String(req.query.referer || session.referer || DEFAULT_STREAM_REFERER).trim();
    const referer = isSafeExternalHttpUrl(refererParam) ? refererParam : DEFAULT_STREAM_REFERER;
    const isHlsSegment = String(req.query.hls_seg || '') === '1';

    if (!isSafeExternalHttpUrl(targetUrl)) {
      res.status(400).send('URL inválida');
      return;
    }

    const reqHost = req.header('host') || `127.0.0.1:${PORT}`;
    const lanBase = `http://${reqHost}`;

    try {
      const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
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
        const rawManifest = await upstream.text();
        const rewritten = rewriteM3u8ForServerLanProxy(
          rawManifest,
          upstream.url || targetUrl,
          lanBase,
          token,
          referer
        );
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.send(rewritten);
        return;
      }

      const shouldProbeTs =
        upstream.ok &&
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
            const rewritten = rewriteM3u8ForServerLanProxy(
              rawManifest,
              upstream.url || targetUrl,
              lanBase,
              token,
              referer
            );
            res.status(200);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
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
          let outAcceptRanges = upstream.headers.get('accept-ranges') || 'bytes';

          if (tsOffset >= 0) {
            outContentType = 'video/mp2t';
            if (tsOffset > 0) {
              if (outContentLength >= tsOffset) outContentLength -= tsOffset;
              else if (outContentLength >= 0) outContentLength = -1;
              if (outStatus === 206) {
                const adjusted = adjustContentRangeForStrip(outContentRange, tsOffset);
                if (adjusted) {
                  outContentRange = adjusted;
                } else {
                  outStatus = 200;
                  outContentRange = null;
                }
              }
              outAcceptRanges = '';
            }
          }

          res.status(outStatus);
          res.setHeader('Content-Type', outContentType);
          if (outContentLength >= 0) res.setHeader('Content-Length', String(outContentLength));
          if (outContentRange) res.setHeader('Content-Range', outContentRange);
          if (outAcceptRanges) res.setHeader('Accept-Ranges', outAcceptRanges);

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
      if (!upstream.headers.get('accept-ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
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
        res.status(502).send(err instanceof Error ? err.message : 'Erro no stream para TV');
      }
    }
  });

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

    if (disableHmr) {
      app.get('/@vite/client', (_req: Request, res: Response) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(`const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptDeps() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) {
  return url;
}
export class ErrorOverlay extends HTMLElement {}
`);
      });
    }

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
    app.get('/{*splat}', (_req: Request, res: Response) => {
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
