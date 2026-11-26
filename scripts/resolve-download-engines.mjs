#!/usr/bin/env node
/**
 * Resolves the latest stable release tags directly from the official upstream
 * repositories:
 *   - https://github.com/aria2/aria2.git
 *   - https://github.com/yt-dlp/yt-dlp.git
 *
 * Uses GitHub's /releases/latest HTTP redirect (never subject to GitHub REST
 * API 403 rate limits) with `git ls-remote --tags` fallback.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ARIA2_REPO_URL = 'https://github.com/aria2/aria2.git';
export const YTDLP_REPO_URL = 'https://github.com/yt-dlp/yt-dlp.git';
export const ARIA2_LATEST_RELEASE_URL = 'https://github.com/aria2/aria2/releases/latest';
export const YTDLP_LATEST_RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest';

export const ARIA2_MAX_CONNECTIONS_PER_SERVER = 16;
export const ARIA2_MAX_SPLITS = 32;
export const ARIA2_MIN_SPLIT_SIZE = '1M';
export const ARIA2_MAX_CONCURRENT_SEGMENTS = 16;

export function parseReleaseTagFromRedirectUrl(locationUrl) {
  if (!locationUrl || typeof locationUrl !== 'string') return '';
  const match = locationUrl.match(/\/releases\/tag\/([^/?#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return match[1].trim();
  }
}

export function compareDotNumericVersions(a, b) {
  const pa = String(a || '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);
  const pb = String(b || '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pickLatestStableAria2Tag(tags) {
  const stable = [];
  for (const raw of tags || []) {
    const tag = String(raw || '').trim();
    const m = tag.match(/^release-(\d+(?:\.\d+)+)$/);
    if (m) {
      stable.push({ tag, ver: m[1] });
    }
  }
  stable.sort((a, b) => compareDotNumericVersions(b.ver, a.ver));
  return stable[0]?.tag || '';
}

export function pickLatestStableYtDlpTag(tags) {
  const stable = [];
  for (const raw of tags || []) {
    const tag = String(raw || '').trim();
    if (/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(tag)) {
      stable.push(tag);
    }
  }
  stable.sort((a, b) => compareDotNumericVersions(b, a));
  return stable[0] || '';
}

export function parseSha256SumsEntry(sha256SumsText, targetFileName) {
  if (!sha256SumsText || !targetFileName) return '';
  const lines = String(sha256SumsText).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const hash = match[1].toLowerCase();
    const file = match[2].trim().replace(/^\.\//, '');
    if (file === targetFileName) {
      return hash;
    }
  }
  return '';
}

export function buildAria2MaxSpeedArgs(options = {}) {
  const {
    dir = '',
    out = '',
    inputFile = '',
    caCertificate = '',
    referer = '',
    userAgent = '',
    concurrentDownloads = ARIA2_MAX_CONCURRENT_SEGMENTS,
    splits = ARIA2_MAX_SPLITS,
    maxConnectionsPerServer = ARIA2_MAX_CONNECTIONS_PER_SERVER,
  } = options;

  const args = [
    `--max-connection-per-server=${Math.max(1, Math.min(16, maxConnectionsPerServer))}`,
    `--split=${Math.max(1, splits)}`,
    `--min-split-size=${ARIA2_MIN_SPLIT_SIZE}`,
    `--max-concurrent-downloads=${Math.max(1, concurrentDownloads)}`,
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
    '--summary-interval=1',
    '--console-log-level=notice',
  ];

  if (caCertificate) {
    args.push(`--ca-certificate=${caCertificate}`);
  }
  if (userAgent) {
    args.push(`--user-agent=${userAgent}`);
  }
  if (referer) {
    args.push(`--referer=${referer}`);
  }
  if (dir) {
    args.push(`--dir=${dir}`);
  }
  if (out) {
    args.push(`--out=${out}`);
  }
  if (inputFile) {
    args.push(`--input-file=${inputFile}`);
  }
  return args;
}

export function buildYtDlpAria2Args(options = {}) {
  const {
    aria2Binary = 'aria2c',
    referer = '',
    userAgent = '',
    outputTemplate = '',
  } = options;

  const aria2DownloaderFlags = [
    `-x ${ARIA2_MAX_CONNECTIONS_PER_SERVER}`,
    `-s ${ARIA2_MAX_SPLITS}`,
    `-k ${ARIA2_MIN_SPLIT_SIZE}`,
    `-j ${ARIA2_MAX_CONCURRENT_SEGMENTS}`,
    '--file-allocation=none',
    '--disk-cache=32M',
    '--max-overall-download-limit=0',
    '--max-download-limit=0',
    '--enable-http-pipelining=true',
    '--optimize-concurrent-downloads=true',
    '--continue=true',
    '--max-tries=5',
    '--retry-wait=1',
  ].join(' ');

  const args = [
    '--no-playlist',
    '--no-part',
    '--no-warnings',
    '--concurrent-fragments',
    String(ARIA2_MAX_CONCURRENT_SEGMENTS),
    '--downloader',
    aria2Binary,
    '--downloader-args',
    `aria2c:${aria2DownloaderFlags}`,
  ];

  if (referer) {
    args.push('--referer', referer);
  }
  if (userAgent) {
    args.push('--user-agent', userAgent);
  }
  if (outputTemplate) {
    args.push('-o', outputTemplate);
  }
  return args;
}

async function resolveTagViaRedirect(latestUrl) {
  try {
    const res = await fetch(latestUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Anisync-Engine-Resolver/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    const loc = res.headers.get('location') || '';
    const tag = parseReleaseTagFromRedirectUrl(loc);
    if (tag) return tag;
  } catch {
    // Fallback to GET redirect or git ls-remote
  }
  try {
    const res = await fetch(latestUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Anisync-Engine-Resolver/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    const loc = res.headers.get('location') || '';
    return parseReleaseTagFromRedirectUrl(loc);
  } catch {
    return '';
  }
}

function listGitRemoteTags(repoUrl, pattern = '') {
  const args = ['ls-remote', '--tags', '--refs', repoUrl];
  if (pattern) args.push(pattern);
  const out = execFileSync('git', args, {
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tags = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const ref = parts[1] || '';
    if (ref.startsWith('refs/tags/')) {
      tags.push(ref.slice('refs/tags/'.length));
    }
  }
  return tags;
}

export async function resolveLatestStableEngines() {
  let aria2Tag = await resolveTagViaRedirect(ARIA2_LATEST_RELEASE_URL);
  if (!/^release-\d+(?:\.\d+)+$/.test(aria2Tag)) {
    aria2Tag = pickLatestStableAria2Tag(listGitRemoteTags(ARIA2_REPO_URL, 'release-*'));
  }
  if (!aria2Tag) {
    throw new Error(`Não foi possível resolver a última tag estável de ${ARIA2_REPO_URL}`);
  }

  let ytdlpTag = await resolveTagViaRedirect(YTDLP_LATEST_RELEASE_URL);
  if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(ytdlpTag)) {
    ytdlpTag = pickLatestStableYtDlpTag(listGitRemoteTags(YTDLP_REPO_URL));
  }
  if (!ytdlpTag) {
    throw new Error(`Não foi possível resolver a última tag estável de ${YTDLP_REPO_URL}`);
  }

  return {
    aria2Tag,
    aria2Version: aria2Tag.replace(/^release-/, ''),
    aria2Repo: ARIA2_REPO_URL,
    ytdlpTag,
    ytdlpVersion: ytdlpTag,
    ytdlpRepo: YTDLP_REPO_URL,
    ytdlpDownloadUrl: `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(ytdlpTag)}/yt-dlp`,
    ytdlpSha256Url: `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(ytdlpTag)}/SHA2-256SUMS`,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const resolved = await resolveLatestStableEngines();

  if (args.has('--github-output') && process.env.GITHUB_OUTPUT) {
    const lines = [
      `aria2_tag=${resolved.aria2Tag}`,
      `aria2_version=${resolved.aria2Version}`,
      `ytdlp_tag=${resolved.ytdlpTag}`,
      `ytdlp_version=${resolved.ytdlpVersion}`,
      `ytdlp_download_url=${resolved.ytdlpDownloadUrl}`,
      `ytdlp_sha256_url=${resolved.ytdlpSha256Url}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`, 'utf8');
  }

  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  } else {
    console.log(`aria2 latest stable: ${resolved.aria2Tag} (${resolved.aria2Repo})`);
    console.log(`yt-dlp latest stable: ${resolved.ytdlpTag} (${resolved.ytdlpRepo})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
