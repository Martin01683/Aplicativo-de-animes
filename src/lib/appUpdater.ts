export const GITHUB_REPO_OWNER = 'Martin01683';
export const GITHUB_REPO_NAME = 'Aplicativo-de-animes';
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;
export const GITHUB_RELEASES_LIST_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases?per_page=5`;
export const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases`;

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
