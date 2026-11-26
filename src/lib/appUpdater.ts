export const GITHUB_REPO_OWNER = 'Martin01683';
export const GITHUB_REPO_NAME = 'Aplicativo-de-animes';
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;
export const GITHUB_RELEASES_LIST_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases?per_page=5`;
export const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases`;
export const GITHUB_LATEST_RELEASE_WEB_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;
export const GITHUB_RELEASES_ATOM_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases.atom`;

export function buildGitHubExpandedAssetsUrl(tagName: string): string {
  return `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/expanded_assets/${encodeURIComponent(tagName.trim())}`;
}

export function buildGitHubReleaseApkDownloadUrl(
  tagName: string,
  assetName = 'Anisync.apk'
): string {
  return `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/download/${encodeURIComponent(tagName.trim())}/${encodeURIComponent(assetName.trim())}`;
}

export interface AppBuildInfo {
  version: string;
  commitSha: string;
  builtAt: string;
  repository: string;
  androidVersionName?: string;
  androidVersionCode?: number;
}

declare const __APP_BUILD_INFO__: AppBuildInfo | undefined;

const FALLBACK_BUILD_INFO: AppBuildInfo = {
  version: '1.0.0',
  commitSha: '',
  builtAt: '',
  repository: `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`,
};

export function getAppBuildInfo(): AppBuildInfo {
  if (typeof __APP_BUILD_INFO__ !== 'undefined' && __APP_BUILD_INFO__) {
    return __APP_BUILD_INFO__;
  }
  return FALLBACK_BUILD_INFO;
}

export interface RemoteApkAsset {
  name: string;
  sizeBytes: number;
  downloadUrl: string;
  updatedAt: string;
  digest?: string;
}

export interface RemoteAppRelease {
  id: number;
  tagName: string;
  releaseName: string;
  htmlUrl: string;
  publishedAt: string;
  updatedAt: string;
  commitSha: string;
  notes: string;
  apkAsset: RemoteApkAsset | null;
}

export interface AppUpdateCheckResult {
  checkedAt: string;
  hasUpdate: boolean;
  reason: 'newer-version' | 'newer-release-build' | 'up-to-date' | 'no-release';
  currentBuild: AppBuildInfo;
  latestRelease: RemoteAppRelease | null;
}

export function extractCommitShaFromNotes(notes: string): string {
  if (!notes) return '';
  const match = notes.match(/\b([0-9a-f]{40})\b/i);
  return match?.[1]?.toLowerCase() || '';
}

export function parseSemverTuple(raw: string): [number, number, number] | null {
  const cleaned = raw.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3] || '0', 10),
  ];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemverTuple(a);
  const pb = parseSemverTuple(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function isAllowedGitHubDownloadUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

export function isAllowedRepoReleaseDownloadUrl(rawUrl: string): boolean {
  if (!isAllowedGitHubDownloadUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) {
      const expectedPrefix = `/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/download/`.toLowerCase();
      return parsed.pathname.toLowerCase().startsWith(expectedPrefix);
    }
    return true;
  } catch {
    return false;
  }
}

function decodeHtmlXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function convertReleaseHtmlToMarkdown(html: string): string {
  return html
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseHumanFileSizeBytes(raw: string): number {
  const match = raw.match(/\b(\d+(?:[.,]\d+)?)\s*(GB|MB|KB|Bytes?)\b/i);
  if (!match) return 0;
  const num = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return 0;
  const unit = match[2].toUpperCase();
  if (unit === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  if (unit === 'MB') return Math.round(num * 1024 * 1024);
  if (unit === 'KB') return Math.round(num * 1024);
  return Math.round(num);
}

export function extractGitHubTagFromUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const match = rawUrl.match(/\/releases\/tag\/([^/?#"]+)/i);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return match[1].trim();
  }
}

export interface GitHubWebLatestReleaseHint {
  id: number;
  tagName: string;
  htmlUrl: string;
}

export function parseGitHubLatestWebJson(
  rawBody: string,
  finalUrl = ''
): GitHubWebLatestReleaseHint | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const tagName = typeof parsed.tag_name === 'string' ? parsed.tag_name.trim() : '';
      if (tagName) {
        const id = typeof parsed.id === 'number' && Number.isFinite(parsed.id) ? parsed.id : 0;
        const updatePath = typeof parsed.update_url === 'string' ? parsed.update_url.trim() : '';
        const candidateUrl = updatePath.startsWith('/')
          ? `https://github.com${updatePath}`
          : `${GITHUB_RELEASES_PAGE_URL}/tag/${encodeURIComponent(tagName)}`;
        return {
          id,
          tagName,
          htmlUrl: isAllowedGitHubDownloadUrl(candidateUrl)
            ? candidateUrl
            : `${GITHUB_RELEASES_PAGE_URL}/tag/${encodeURIComponent(tagName)}`,
        };
      }
    }
  } catch {
    // Non-JSON HTML redirect response — fall back to finalUrl extraction below
  }

  const tagFromUrl = extractGitHubTagFromUrl(finalUrl);
  if (tagFromUrl) {
    return {
      id: 0,
      tagName: tagFromUrl,
      htmlUrl: `${GITHUB_RELEASES_PAGE_URL}/tag/${encodeURIComponent(tagFromUrl)}`,
    };
  }
  return null;
}

export function parseGitHubExpandedAssetsHtml(
  html: string,
  expectedTagName?: string
): RemoteApkAsset | null {
  if (!html || typeof html !== 'string') return null;
  const repoPrefix = `/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/download/`.toLowerCase();
  const listItems = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [html];

  for (const block of listItems) {
    const linkMatch = block.match(/href="([^"]*\/releases\/download\/[^"]+\.apk)"/i);
    if (!linkMatch?.[1]) continue;

    const rawHref = decodeHtmlXmlEntities(linkMatch[1]).trim();
    const downloadUrl = rawHref.startsWith('https://')
      ? rawHref
      : rawHref.startsWith('/')
        ? `https://github.com${rawHref}`
        : '';
    if (!downloadUrl || !isAllowedRepoReleaseDownloadUrl(downloadUrl)) continue;

    const lowerPath = new URL(downloadUrl).pathname.toLowerCase();
    if (!lowerPath.startsWith(repoPrefix)) continue;

    if (expectedTagName) {
      const encodedTag = encodeURIComponent(expectedTagName.trim()).toLowerCase();
      const rawTag = expectedTagName.trim().toLowerCase();
      if (
        !lowerPath.includes(`/releases/download/${encodedTag}/`) &&
        !lowerPath.includes(`/releases/download/${rawTag}/`)
      ) {
        continue;
      }
    }

    const fileSegment = new URL(downloadUrl).pathname.split('/').pop() || 'Anisync.apk';
    let name = fileSegment;
    try {
      name = decodeURIComponent(fileSegment);
    } catch {
      // keep raw file segment
    }

    const digestMatch = block.match(/\bsha256:([0-9a-f]{64})\b/i);
    const digest = digestMatch?.[1] ? `sha256:${digestMatch[1].toLowerCase()}` : undefined;
    const sizeBytes = parseHumanFileSizeBytes(block);
    const timeMatch = block.match(/<relative-time\b[^>]*\bdatetime="([^"]+)"/i);
    const updatedAt = timeMatch?.[1]?.trim() || '';

    return {
      name,
      sizeBytes,
      downloadUrl,
      updatedAt,
      ...(digest ? { digest } : {}),
    };
  }

  return null;
}

export interface GitHubAtomReleaseEntry {
  tagName: string;
  releaseName: string;
  htmlUrl: string;
  updatedAt: string;
  notes: string;
  commitSha: string;
}

export function parseGitHubReleasesAtom(
  xml: string,
  expectedTagName?: string
): GitHubAtomReleaseEntry | null {
  if (!xml || typeof xml !== 'string') return null;
  const entries = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi);
  if (!entries || entries.length === 0) return null;

  const parsedEntries: GitHubAtomReleaseEntry[] = [];
  for (const entry of entries) {
    const linkMatch = entry.match(/<link\b[^>]*\bhref="([^"]+)"/i);
    const rawHref = linkMatch?.[1] ? decodeHtmlXmlEntities(linkMatch[1]).trim() : '';
    const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/i);
    const idTag = idMatch?.[1]
      ? decodeHtmlXmlEntities(idMatch[1]).trim().split('/').pop() || ''
      : '';
    const tagName = extractGitHubTagFromUrl(rawHref) || idTag;
    if (!tagName) continue;

    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const releaseName = titleMatch?.[1]
      ? decodeHtmlXmlEntities(titleMatch[1]).trim() || tagName
      : tagName;
    const updatedMatch = entry.match(/<updated>([\s\S]*?)<\/updated>/i);
    const updatedAt = updatedMatch?.[1] ? updatedMatch[1].trim() : '';
    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
    const decodedContent = contentMatch?.[1] ? decodeHtmlXmlEntities(contentMatch[1]) : '';
    const notes = convertReleaseHtmlToMarkdown(decodedContent);
    const commitSha = extractCommitShaFromNotes(notes);
    const htmlUrl =
      rawHref && isAllowedGitHubDownloadUrl(rawHref)
        ? rawHref
        : `${GITHUB_RELEASES_PAGE_URL}/tag/${encodeURIComponent(tagName)}`;

    parsedEntries.push({
      tagName,
      releaseName,
      htmlUrl,
      updatedAt,
      notes,
      commitSha,
    });
  }

  if (parsedEntries.length === 0) return null;
  if (expectedTagName) {
    const target = expectedTagName.trim().toLowerCase();
    const matched = parsedEntries.find((e) => e.tagName.toLowerCase() === target);
    if (matched) return matched;
  }
  return parsedEntries[0];
}

export function buildFallbackRemoteRelease(params: {
  latestHint?: GitHubWebLatestReleaseHint | null;
  atomEntry?: GitHubAtomReleaseEntry | null;
  apkAsset?: RemoteApkAsset | null;
}): RemoteAppRelease | null {
  const tagName = (params.latestHint?.tagName || params.atomEntry?.tagName || '').trim();
  if (!tagName) return null;

  const htmlUrl =
    params.latestHint?.htmlUrl ||
    params.atomEntry?.htmlUrl ||
    `${GITHUB_RELEASES_PAGE_URL}/tag/${encodeURIComponent(tagName)}`;
  const publishedAt = params.atomEntry?.updatedAt || params.apkAsset?.updatedAt || '';
  const updatedAt = params.apkAsset?.updatedAt || params.atomEntry?.updatedAt || '';
  const apkAsset: RemoteApkAsset = params.apkAsset || {
    name: 'Anisync.apk',
    sizeBytes: 0,
    downloadUrl: buildGitHubReleaseApkDownloadUrl(tagName),
    updatedAt,
  };

  return {
    id: params.latestHint?.id || 0,
    tagName,
    releaseName: params.atomEntry?.releaseName || `Anisync ${tagName}`,
    htmlUrl,
    publishedAt,
    updatedAt,
    commitSha: params.atomEntry?.commitSha || '',
    notes: params.atomEntry?.notes || '',
    apkAsset,
  };
}

export function normalizeSha256Digest(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/^sha256:/i, '').trim();
  return /^[0-9a-f]{64}$/i.test(cleaned) ? cleaned.toLowerCase() : '';
}

export function parseGitHubReleasePayload(payload: unknown): RemoteAppRelease | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  const tagName = typeof obj.tag_name === 'string' ? obj.tag_name.trim() : '';
  if (!tagName) return null;

  const notes = typeof obj.body === 'string' ? obj.body : '';
  const targetCommitish =
    typeof obj.target_commitish === 'string' ? obj.target_commitish.trim().toLowerCase() : '';
  const shaFromNotes = extractCommitShaFromNotes(notes);
  const commitSha =
    shaFromNotes || (/^[0-9a-f]{7,40}$/i.test(targetCommitish) ? targetCommitish : '');

  const rawAssets = Array.isArray(obj.assets) ? obj.assets : [];
  let apkAsset: RemoteApkAsset | null = null;
  for (const rawAsset of rawAssets) {
    if (!rawAsset || typeof rawAsset !== 'object') continue;
    const asset = rawAsset as Record<string, unknown>;
    const name = typeof asset.name === 'string' ? asset.name : '';
    const downloadUrl =
      typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (!/\.apk$/i.test(name) || !isAllowedGitHubDownloadUrl(downloadUrl)) continue;
    apkAsset = {
      name,
      sizeBytes: typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : 0,
      downloadUrl,
      updatedAt:
        typeof asset.updated_at === 'string'
          ? asset.updated_at
          : typeof obj.updated_at === 'string'
            ? obj.updated_at
            : '',
      digest: typeof asset.digest === 'string' ? asset.digest : undefined,
    };
    break;
  }

  const htmlUrl =
    typeof obj.html_url === 'string' && isAllowedGitHubDownloadUrl(obj.html_url)
      ? obj.html_url
      : GITHUB_RELEASES_PAGE_URL;

  const publishedAt =
    typeof obj.published_at === 'string'
      ? obj.published_at
      : typeof obj.created_at === 'string'
        ? obj.created_at
        : '';

  const updatedAt =
    apkAsset?.updatedAt ||
    (typeof obj.updated_at === 'string' ? obj.updated_at : '') ||
    publishedAt;

  return {
    id: typeof obj.id === 'number' ? obj.id : 0,
    tagName,
    releaseName:
      typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : tagName,
    htmlUrl,
    publishedAt,
    updatedAt,
    commitSha,
    notes,
    apkAsset,
  };
}

export function evaluateUpdateStatus(params: {
  currentBuild: AppBuildInfo;
  remoteRelease: RemoteAppRelease | null;
  acknowledgedReleaseKey?: string | null;
  checkedAt?: string;
}): AppUpdateCheckResult {
  const {
    currentBuild,
    remoteRelease,
    acknowledgedReleaseKey = null,
    checkedAt = new Date().toISOString(),
  } = params;

  if (!remoteRelease) {
    return {
      checkedAt,
      hasUpdate: false,
      reason: 'no-release',
      currentBuild,
      latestRelease: null,
    };
  }

  const currentVer = currentBuild.androidVersionName || currentBuild.version;
  const remoteReleaseKey = buildReleaseIdentityKey(remoteRelease);

  if (acknowledgedReleaseKey && acknowledgedReleaseKey === remoteReleaseKey) {
    return {
      checkedAt,
      hasUpdate: false,
      reason: 'up-to-date',
      currentBuild,
      latestRelease: remoteRelease,
    };
  }

  // 1. Check semver tag if release uses semantic versioning (e.g. v1.2.0)
  if (parseSemverTuple(remoteRelease.tagName) && parseSemverTuple(currentVer)) {
    const cmp = compareSemver(remoteRelease.tagName, currentVer);
    if (cmp > 0) {
      return {
        checkedAt,
        hasUpdate: true,
        reason: 'newer-version',
        currentBuild,
        latestRelease: remoteRelease,
      };
    }
    if (cmp < 0) {
      return {
        checkedAt,
        hasUpdate: false,
        reason: 'up-to-date',
        currentBuild,
        latestRelease: remoteRelease,
      };
    }
  }

  // 2. Compare commit SHA for rolling releases (e.g. tag_name = "latest-apk")
  const localSha = currentBuild.commitSha.trim().toLowerCase();
  const remoteSha = remoteRelease.commitSha.trim().toLowerCase();
  if (localSha && remoteSha && (localSha.startsWith(remoteSha) || remoteSha.startsWith(localSha))) {
    return {
      checkedAt,
      hasUpdate: false,
      reason: 'up-to-date',
      currentBuild,
      latestRelease: remoteRelease,
    };
  }

  // 3. Compare timestamps (with 2-minute tolerance so CI build time right after commit doesn't mismatch)
  const remoteTime = Date.parse(remoteRelease.updatedAt || remoteRelease.publishedAt);
  const localTime = Date.parse(currentBuild.builtAt);

  if (Number.isFinite(remoteTime) && Number.isFinite(localTime)) {
    if (remoteTime > localTime + 2 * 60 * 1000) {
      return {
        checkedAt,
        hasUpdate: true,
        reason: 'newer-release-build',
        currentBuild,
        latestRelease: remoteRelease,
      };
    }
    return {
      checkedAt,
      hasUpdate: false,
      reason: 'up-to-date',
      currentBuild,
      latestRelease: remoteRelease,
    };
  }

  // If no local timestamp/SHA was baked in (e.g. unversioned environment), treat a valid APK release
  // as available unless acknowledged.
  if (!localSha && !Number.isFinite(localTime) && remoteRelease.apkAsset) {
    return {
      checkedAt,
      hasUpdate: true,
      reason: 'newer-release-build',
      currentBuild,
      latestRelease: remoteRelease,
    };
  }

  return {
    checkedAt,
    hasUpdate: false,
    reason: 'up-to-date',
    currentBuild,
    latestRelease: remoteRelease,
  };
}

export function buildReleaseIdentityKey(release: RemoteAppRelease): string {
  return `${release.tagName}::${release.commitSha || release.updatedAt || release.id}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${Math.round(kb)} KB`;
}

export function formatShortSha(sha: string): string {
  const clean = sha.trim();
  return clean ? clean.slice(0, 7) : 'local';
}

export type ApkDownloadStage =
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'installed'
  | 'cancelled'
  | 'error';

export interface ApkDownloadProgressState {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  stage: ApkDownloadStage;
  message?: string;
}

export function isCancelledApkProgressEvent(
  event: Pick<ApkDownloadProgressState, 'stage' | 'message'> | null | undefined
): boolean {
  if (!event) return false;
  if (event.stage === 'cancelled') return true;
  if (event.stage === 'error' && event.message) {
    return /\bcancelad[oa]\b/i.test(event.message);
  }
  return false;
}

export function reduceApkDownloadProgress(
  event: ApkDownloadProgressState | null
): {
  progress: ApkDownloadProgressState | null;
  downloading: boolean;
  toastMessage?: string;
  acknowledgeRelease?: boolean;
} {
  if (!event) {
    return { progress: null, downloading: false };
  }
  if (isCancelledApkProgressEvent(event)) {
    return {
      progress: null,
      downloading: false,
      toastMessage: event.message || 'Atualização cancelada.',
    };
  }
  if (event.stage === 'installed') {
    return {
      progress: event,
      downloading: false,
      toastMessage: 'Atualização instalada com sucesso!',
      acknowledgeRelease: true,
    };
  }
  if (event.stage === 'error') {
    return {
      progress: event,
      downloading: false,
      toastMessage: event.message || 'Falha ao atualizar APK.',
    };
  }
  return {
    progress: event,
    downloading: true,
  };
}
