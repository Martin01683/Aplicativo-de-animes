import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StreamQuality, SubtitleTrack } from './types.ts';
import { isSafeExternalHttpUrl } from './urlSafety.ts';
import { DEFAULT_BROWSER_UA } from './vlc.ts';

const execFileAsync = promisify(execFile);

export const SERVER_ARIA2_REPO_URL = 'https://github.com/aria2/aria2.git';
export const SERVER_YTDLP_REPO_URL = 'https://github.com/yt-dlp/yt-dlp.git';
export const SERVER_ARIA2_MAX_CONNECTIONS_PER_SERVER = 16;
export const SERVER_ARIA2_MAX_SPLITS = 32;
export const SERVER_ARIA2_MAX_CONCURRENT_SEGMENTS = 16;
export const SERVER_ARIA2_MIN_SPLIT_SIZE = '1M';

export interface DownloadEngineStatus {
  aria2Available: boolean;
  aria2Version: string;
  ytdlpAvailable: boolean;
  ytdlpVersion: string;
  maxConnectionsPerServer: number;
  maxSplits: number;
  maxConcurrentSegments: number;
  aria2Repo: string;
  ytdlpRepo: string;
}

export interface ServerFastDownloadResult {
  filePath: string;
  sizeBytes: number;
  contentType: string;
  engine: 'aria2c' | 'node-parallel' | 'node-stream';
  cleanup: () => void;
}

interface BinaryDetection {
  binary: string;
  version: string;
}

let cachedDetection: {
  aria2: BinaryDetection | null;
  ytdlp: BinaryDetection | null;
  checkedAt: number;
} | null = null;

async function probeBinary(candidates: string[], versionArg: string): Promise<BinaryDetection | null> {
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      const { stdout, stderr } = await execFileAsync(bin, [versionArg], {
        timeout: 4000,
        windowsHide: true,
      });
      const text = `${stdout || ''}\n${stderr || ''}`.trim();
      const firstLine = text.split(/\r?\n/)[0] || '';
      const verMatch = firstLine.match(/(\d+(?:\.\d+)+)/);
      return {
        binary: bin,
        version: verMatch ? verMatch[1] : firstLine.slice(0, 32),
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function detectHostBinaries(force = false): Promise<{
  aria2: BinaryDetection | null;
  ytdlp: BinaryDetection | null;
}> {
  if (!force && cachedDetection && Date.now() - cachedDetection.checkedAt < 60_000) {
    return { aria2: cachedDetection.aria2, ytdlp: cachedDetection.ytdlp };
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const localCacheDir = path.resolve(process.cwd(), '.cache/download-engines');

  const [aria2, ytdlp] = await Promise.all([
    probeBinary(
      [
        process.env.ARIA2C_PATH || '',
        path.join(localCacheDir, `aria2c${ext}`),
        `aria2c${ext}`,
        'aria2c',
      ],
      '--version'
    ),
    probeBinary(
      [
        process.env.YTDLP_PATH || '',
        path.join(localCacheDir, `yt-dlp${ext}`),
        `yt-dlp${ext}`,
        'yt-dlp',
      ],
      '--version'
    ),
  ]);

  cachedDetection = { aria2, ytdlp, checkedAt: Date.now() };
  return { aria2, ytdlp };
}

export async function getServerDownloadEnginesStatus(): Promise<DownloadEngineStatus> {
  const { aria2, ytdlp } = await detectHostBinaries();
  return {
    aria2Available: Boolean(aria2),
    aria2Version: aria2?.version || '',
    ytdlpAvailable: Boolean(ytdlp),
    ytdlpVersion: ytdlp?.version || '',
    maxConnectionsPerServer: SERVER_ARIA2_MAX_CONNECTIONS_PER_SERVER,
    maxSplits: SERVER_ARIA2_MAX_SPLITS,
    maxConcurrentSegments: SERVER_ARIA2_MAX_CONCURRENT_SEGMENTS,
    aria2Repo: SERVER_ARIA2_REPO_URL,
    ytdlpRepo: SERVER_YTDLP_REPO_URL,
  };
}

export function buildServerAria2Args(options: {
  url: string;
  outDir: string;
  outFileName: string;
  referer?: string;
}): string[] {
  const args = [
    `--max-connection-per-server=${SERVER_ARIA2_MAX_CONNECTIONS_PER_SERVER}`,
    `--split=${SERVER_ARIA2_MAX_SPLITS}`,
    `--min-split-size=${SERVER_ARIA2_MIN_SPLIT_SIZE}`,
    `--max-concurrent-downloads=${SERVER_ARIA2_MAX_CONCURRENT_SEGMENTS}`,
    '--file-allocation=none',
    '--disk-cache=32M',
    '--max-overall-download-limit=0',
    '--max-download-limit=0',
    '--lowest-speed-limit=0',
    '--enable-http-pipelining=true',
    '--optimize-concurrent-downloads=true',
    '--http-accept-gzip=false',
    '--continue=true',
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--max-tries=5',
    '--retry-wait=1',
    '--timeout=30',
    '--connect-timeout=15',
    '--summary-interval=0',
    '--console-log-level=warn',
    `--user-agent=${DEFAULT_BROWSER_UA}`,
    `--dir=${options.outDir}`,
    `--out=${options.outFileName}`,
  ];
  if (options.referer && isSafeExternalHttpUrl(options.referer)) {
    args.push(`--referer=${options.referer}`);
  }
  args.push(options.url);
  return args;
}

async function runServerAria2Download(
  aria2Bin: string,
  url: string,
  referer: string,
  tmpDir: string,
  outFileName: string,
  signal?: AbortSignal
): Promise<string> {
  const outPath = path.join(tmpDir, outFileName);
  const args = buildServerAria2Args({
    url,
    outDir: tmpDir,
    outFileName,
    referer,
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(aria2Bin, args, {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let errBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBuf.length < 800) errBuf += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const txt = chunk.toString('utf8');
      if ((txt.includes('ERROR') || txt.includes('errorCode=')) && errBuf.length < 800) {
        errBuf += txt;
      }
    });

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error('Download cancelado.'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`aria2c retornou código ${code}: ${errBuf.trim()}`));
      }
    });
  });

  const stat = await fsp.stat(outPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error('aria2c finalizou sem gravar dados de vídeo.');
  }
  return outPath;
}

function buildFetchHeaders(referer: string, range?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_BROWSER_UA,
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  };
  if (referer && isSafeExternalHttpUrl(referer)) {
    headers.Referer = referer;
  }
  if (range) {
    headers.Range = range;
  }
  return headers;
}

async function runNodeParallelRangeDownload(
  url: string,
  referer: string,
  outPath: string,
  signal?: AbortSignal
): Promise<{ sizeBytes: number; contentType: string; engine: 'node-parallel' | 'node-stream' }> {
  const probeRes = await fetch(url, {
    method: 'GET',
    headers: buildFetchHeaders(referer, 'bytes=0-4095'),
    redirect: 'follow',
    signal,
  });
  if (!probeRes.ok) {
    throw new Error(`Servidor retornou HTTP ${probeRes.status} ao iniciar download.`);
  }
  const finalUrl = probeRes.url || url;
  const contentType = probeRes.headers.get('content-type') || 'video/mp4';
  const contentRange = probeRes.headers.get('content-range') || '';
  const rangeTotalMatch = contentRange.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  const totalBytes = rangeTotalMatch
    ? Number.parseInt(rangeTotalMatch[1], 10)
    : Number.parseInt(probeRes.headers.get('content-length') || '0', 10) || 0;
  const supportsRange =
    probeRes.status === 206 ||
    /bytes/i.test(probeRes.headers.get('accept-ranges') || '');

  // Drain/cancel probe body immediately
  try {
    await probeRes.body?.cancel();
  } catch {
    // ignore
  }

  if (supportsRange && totalBytes >= 2 * 1024 * 1024) {
    const workers = Math.min(
      SERVER_ARIA2_MAX_CONNECTIONS_PER_SERVER,
      Math.max(4, Math.ceil(totalBytes / (2 * 1024 * 1024)))
    );
    const chunkSize = Math.ceil(totalBytes / workers);
    const fh = await fsp.open(outPath, 'w+');
    try {
      await fh.truncate(totalBytes);
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < workers; i += 1) {
        const start = i * chunkSize;
        if (start >= totalBytes) break;
        const end = Math.min(totalBytes - 1, start + chunkSize - 1);
        tasks.push(
          (async () => {
            let cursor = start;
            let lastErr: unknown;
            for (let attempt = 1; attempt <= 4; attempt += 1) {
              if (signal?.aborted) throw new Error('Download cancelado.');
              try {
                const res = await fetch(finalUrl, {
                  method: 'GET',
                  headers: buildFetchHeaders(referer, `bytes=${cursor}-${end}`),
                  redirect: 'follow',
                  signal,
                });
                if (res.status !== 206 || !res.body) {
                  throw new Error(`HTTP ${res.status} ao baixar segmento paralelo.`);
                }
                const reader = res.body.getReader();
                while (cursor <= end) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value && value.byteLength > 0) {
                    const maxWrite = Math.min(value.byteLength, end - cursor + 1);
                    await fh.write(value, 0, maxWrite, cursor);
                    cursor += maxWrite;
                  }
                }
                if (cursor > end) return;
                throw new Error('Trecho paralelo incompleto.');
              } catch (err) {
                lastErr = err;
                if (attempt < 4 && !signal?.aborted) {
                  await new Promise((r) => setTimeout(r, attempt * 600));
                  continue;
                }
                throw err;
              }
            }
            throw lastErr;
          })()
        );
      }
      await Promise.all(tasks);
      return { sizeBytes: totalBytes, contentType, engine: 'node-parallel' };
    } finally {
      await fh.close();
    }
  }

  // Fallback single-stream fetch
  const fullRes = await fetch(finalUrl, {
    method: 'GET',
    headers: buildFetchHeaders(referer),
    redirect: 'follow',
    signal,
  });
  if (!fullRes.ok || !fullRes.body) {
    throw new Error(`Servidor retornou HTTP ${fullRes.status} ao baixar vídeo.`);
  }
  const ws = fs.createWriteStream(outPath);
  const reader = fullRes.body.getReader();
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        written += value.byteLength;
        if (!ws.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) {
          await new Promise<void>((resolve) => ws.once('drain', resolve));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
      ws.end();
    });
  } catch (err) {
    ws.destroy();
    throw err;
  }
  return { sizeBytes: written, contentType, engine: 'node-stream' };
}

export async function downloadWithServerAria2OrParallel(options: {
  url: string;
  referer?: string;
  signal?: AbortSignal;
}): Promise<ServerFastDownloadResult> {
  const referer = options.referer || 'https://topanimes.net/';
  const tmpDir = path.join(os.tmpdir(), `anisync-dl-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  const cleanup = () => {
    void fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const { aria2 } = await detectHostBinaries();
    const outFileName = 'video.mp4';
    const outPath = path.join(tmpDir, outFileName);

    if (aria2?.binary) {
      try {
        await runServerAria2Download(
          aria2.binary,
          options.url,
          referer,
          tmpDir,
          outFileName,
          options.signal
        );
        const stat = await fsp.stat(outPath);
        return {
          filePath: outPath,
          sizeBytes: stat.size,
          contentType: 'video/mp4',
          engine: 'aria2c',
          cleanup,
        };
      } catch (err) {
        if (options.signal?.aborted) throw err;
        // Fall back to parallel Range downloader cleanly
        await fsp.rm(outPath, { force: true }).catch(() => {});
      }
    }

    const fallback = await runNodeParallelRangeDownload(
      options.url,
      referer,
      outPath,
      options.signal
    );
    return {
      filePath: outPath,
      sizeBytes: fallback.sizeBytes,
      contentType: fallback.contentType,
      engine: fallback.engine,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export async function resolveEmbedWithServerYtDlp(
  embedUrl: string,
  referer = 'https://topanimes.net/'
): Promise<{
  ok: boolean;
  streams: StreamQuality[];
  subtitles: SubtitleTrack[];
  referer: string;
  errorMessage?: string;
}> {
  if (!isSafeExternalHttpUrl(embedUrl)) {
    return { ok: false, streams: [], subtitles: [], referer, errorMessage: 'URL de embed inválida.' };
  }
  const { ytdlp } = await detectHostBinaries();
  if (!ytdlp?.binary) {
    return {
      ok: false,
      streams: [],
      subtitles: [],
      referer,
      errorMessage: 'yt-dlp não está instalado no servidor.',
    };
  }

  try {
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      '--socket-timeout',
      '15',
      '--user-agent',
      DEFAULT_BROWSER_UA,
    ];
    if (referer && isSafeExternalHttpUrl(referer)) {
      args.push('--referer', referer);
    }
    args.push(embedUrl);

    const { stdout } = await execFileAsync(ytdlp.binary, args, {
      timeout: 25_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const idx = stdout.indexOf('{');
    if (idx < 0) {
      return { ok: false, streams: [], subtitles: [], referer, errorMessage: 'yt-dlp sem resposta JSON.' };
    }
    const parsed = JSON.parse(stdout.slice(idx)) as {
      url?: string;
      height?: number;
      http_headers?: Record<string, string>;
      formats?: Array<{
        url?: string;
        height?: number;
        ext?: string;
        protocol?: string;
        vcodec?: string;
        acodec?: string;
        format_note?: string;
      }>;
      subtitles?: Record<string, Array<{ url?: string; ext?: string; name?: string }>>;
    };

    const resolvedReferer =
      parsed.http_headers?.Referer && isSafeExternalHttpUrl(parsed.http_headers.Referer)
        ? parsed.http_headers.Referer
        : referer;

    const seen = new Set<string>();
    const streams: StreamQuality[] = [];

    for (const f of parsed.formats || []) {
      const fUrl = (f.url || '').trim();
      if (!isSafeExternalHttpUrl(fUrl) || seen.has(fUrl)) continue;
      if (f.vcodec === 'none') continue;
      const isHls =
        /m3u8/i.test(f.protocol || '') || /\.m3u8(?:$|\?)/i.test(fUrl);
      if (!isHls && f.acodec === 'none') continue;
      seen.add(fUrl);
      const height = Number(f.height || 0);
      streams.push({
        label: height > 0 ? `${height}p` : f.format_note || (isHls ? 'HLS' : 'MP4'),
        height,
        url: fUrl,
        format: isHls ? 'hls' : f.ext === 'mp4' ? 'mp4' : 'unknown',
      });
    }

    if (parsed.url && isSafeExternalHttpUrl(parsed.url) && !seen.has(parsed.url)) {
      const isHls = /\.m3u8(?:$|\?)/i.test(parsed.url);
      const height = Number(parsed.height || 0);
      streams.push({
        label: height > 0 ? `${height}p` : isHls ? 'HLS' : 'MP4',
        height,
        url: parsed.url,
        format: isHls ? 'hls' : 'mp4',
      });
    }

    streams.sort((a, b) => (b.height || 0) - (a.height || 0));

    const subtitles: SubtitleTrack[] = [];
    for (const [lang, entries] of Object.entries(parsed.subtitles || {})) {
      const hit = (entries || []).find(
        (e) =>
          e.url &&
          isSafeExternalHttpUrl(e.url) &&
          ['vtt', 'srt', 'ass'].includes((e.ext || '').toLowerCase())
      );
      if (hit?.url) {
        subtitles.push({
          label: hit.name || lang,
          url: hit.url,
          isDefault: /^pt/i.test(lang),
        });
      }
    }

    if (!streams.length) {
      return {
        ok: false,
        streams: [],
        subtitles,
        referer: resolvedReferer,
        errorMessage: 'yt-dlp não encontrou stream reproduzível.',
      };
    }

    return { ok: true, streams, subtitles, referer: resolvedReferer };
  } catch (err) {
    return {
      ok: false,
      streams: [],
      subtitles: [],
      referer,
      errorMessage: err instanceof Error ? err.message : 'Falha na extração via yt-dlp.',
    };
  }
}
