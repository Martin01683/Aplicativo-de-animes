import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  isAllowedGitHubDownloadUrl,
  normalizeSha256Digest,
  type ApkDownloadProgressState,
} from './appUpdater.ts';
import type { HttpFetchOptions, HttpFetchResult, HttpFetcher } from './httpTypes.ts';
import { dispatchAnisyncApiRequest } from './anisyncApiRouter.ts';
import { loadAppSettings } from './storage.ts';
import type { CatalogPreferences } from './types.ts';
import { isSafeExternalHttpUrl } from './urlSafety.ts';

export type NativeFetchPageOptions = HttpFetchOptions & {
  url: string;
};

export type NativeFetchPageResult = HttpFetchResult;

export interface NativeAppBuildInfoResult {
  versionName: string;
  versionCode: number;
}

export type ApkDownloadProgressEvent = ApkDownloadProgressState;

export interface LocalProxyPlugin {
  getProxyBaseUrl(): Promise<{ baseUrl: string }>;
  fetchPage(options: NativeFetchPageOptions): Promise<NativeFetchPageResult>;
  openExternalUrl(options: { url: string }): Promise<{ opened: boolean }>;
  getAppBuildInfo(): Promise<NativeAppBuildInfoResult>;
  downloadAndInstallApk(options: {
    url: string;
    filename?: string;
    expectedSha256?: string;
  }): Promise<{ started: boolean; cancelled?: boolean; needsPermission?: boolean; message?: string }>;
  cancelApkDownload(): Promise<{ cancelled: boolean }>;
  addListener(
    eventName: 'apkDownloadProgress',
    listenerFunc: (event: ApkDownloadProgressEvent) => void
  ): Promise<PluginListenerHandle>;
}

const LocalProxy = registerPlugin<LocalProxyPlugin>('LocalProxy');

const DEFAULT_STREAM_REFERER = 'https://topanimes.net/';

let cachedProxyBaseUrl = '';

export function isNativeAndroidApp(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export async function initApiClient(): Promise<void> {
  if (!isNativeAndroidApp()) return;
  try {
    const res = await LocalProxy.getProxyBaseUrl();
    if (res?.baseUrl) {
      cachedProxyBaseUrl = res.baseUrl.replace(/\/+$/, '');
    }
  } catch {
    // Fallback will retry lazily when needed
  }
}

async function ensureProxyBaseUrl(): Promise<string> {
  if (cachedProxyBaseUrl) return cachedProxyBaseUrl;
  if (!isNativeAndroidApp()) return '';
  try {
    const res = await LocalProxy.getProxyBaseUrl();
    if (res?.baseUrl) {
      cachedProxyBaseUrl = res.baseUrl.replace(/\/+$/, '');
      return cachedProxyBaseUrl;
    }
  } catch {
    // Ignore
  }
  return '';
}

export function getStreamProxyUrl(targetUrl: string, referer = DEFAULT_STREAM_REFERER): string {
  const params = new URLSearchParams({
    url: targetUrl,
    referer: referer || DEFAULT_STREAM_REFERER,
  });
  if (isNativeAndroidApp() && cachedProxyBaseUrl) {
    return `${cachedProxyBaseUrl}/stream-proxy?${params.toString()}`;
  }
  return `/api/stream-proxy?${params.toString()}`;
}

export async function getStreamProxyUrlAsync(
  targetUrl: string,
  referer = DEFAULT_STREAM_REFERER
): Promise<string> {
  if (isNativeAndroidApp() && !cachedProxyBaseUrl) {
    await ensureProxyBaseUrl();
  }
  return getStreamProxyUrl(targetUrl, referer);
}

export async function openExternalOrVlcUrl(url: string): Promise<boolean> {
  if (isNativeAndroidApp()) {
    try {
      const res = await LocalProxy.openExternalUrl({ url });
      return Boolean(res?.opened);
    } catch {
      return false;
    }
  }
  window.location.href = url;
  return true;
}

export async function getNativeAppBuildInfo(): Promise<NativeAppBuildInfoResult | null> {
  if (!isNativeAndroidApp()) return null;
  try {
    return await LocalProxy.getAppBuildInfo();
  } catch {
    return null;
  }
}

export async function addApkDownloadProgressListener(
  listener: (event: ApkDownloadProgressEvent) => void
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroidApp()) return null;
  try {
    return await LocalProxy.addListener('apkDownloadProgress', listener);
  } catch {
    return null;
  }
}

export async function cancelAppUpdateDownload(): Promise<boolean> {
  if (!isNativeAndroidApp()) return false;
  try {
    const res = await LocalProxy.cancelApkDownload();
    return Boolean(res?.cancelled);
  } catch {
    return false;
  }
}

export async function downloadAppUpdateApk(
  downloadUrl: string,
  filename = 'Anisync.apk',
  expectedSha256?: string
): Promise<{
  mode: 'native-installer' | 'permission-required' | 'browser-download' | 'cancelled';
  message?: string;
}> {
  if (!isAllowedGitHubDownloadUrl(downloadUrl)) {
    throw new Error('URL de download do GitHub inválida ou não permitida.');
  }
  if (isNativeAndroidApp()) {
    const cleanSha256 = normalizeSha256Digest(expectedSha256);
    const res = await LocalProxy.downloadAndInstallApk({
      url: downloadUrl,
      filename,
      expectedSha256: cleanSha256 || undefined,
    });
    if (res?.cancelled) {
      return {
        mode: 'cancelled',
        message: res.message || 'Atualização cancelada.',
      };
    }
    if (res?.needsPermission) {
      return {
        mode: 'permission-required',
        message:
          res.message ||
          "Ative 'Permitir desta fonte' nas configurações do Android e tente novamente.",
      };
    }
    return { mode: 'native-installer' };
  }

  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = filename;
  anchor.rel = 'noopener noreferrer';
  anchor.target = '_blank';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return { mode: 'browser-download' };
}

export interface ApiJsonResponse {
  status: number;
  body: unknown;
}

export type PageFetcher = HttpFetcher;
export type SnapshotFetcher = (assetPath: string) => Promise<string | null>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

const nativePageFetcher: PageFetcher = async (url, options = {}) => {
  if (!isSafeExternalHttpUrl(url)) {
    throw new Error('URL externa inválida ou bloqueada por segurança.');
  }
  return LocalProxy.fetchPage({
    url,
    referer: options.referer,
    accept: options.accept,
    timeoutMs: options.timeoutMs,
    method: options.method,
    body: options.body,
    contentType: options.contentType,
    headers: options.headers,
  });
};

function getStoredRuntimePreferences(): {
  catalogPrefs?: CatalogPreferences;
} {
  if (typeof localStorage === 'undefined') return {};
  try {
    const settings = loadAppSettings();
    return {
      catalogPrefs: {
        credentials: settings.catalogCredentials,
      },
    };
  } catch {
    return {};
  }
}

function encodeBase64Json(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    if (typeof btoa === 'function') {
      return btoa(unescape(encodeURIComponent(json)));
    }
    return Buffer.from(json, 'utf8').toString('base64');
  } catch {
    return null;
  }
}

function encodeCatalogConfigHeader(prefs?: CatalogPreferences): string | null {
  if (!prefs) return null;
  const hasCreds = Object.values(prefs.credentials || {}).some((v) => Boolean(v));
  if (!hasCreds) return null;
  return encodeBase64Json(prefs);
}

const defaultBrowserSnapshotReader: SnapshotFetcher = async () => null;

export async function routeNativeApiRequest(
  pathWithQuery: string,
  init: RequestInit | undefined,
  deps: {
    fetchPage?: PageFetcher;
    readSnapshot?: SnapshotFetcher;
    catalogPrefs?: CatalogPreferences;
  } = {}
): Promise<ApiJsonResponse> {
  const fetchHttp = deps.fetchPage || nativePageFetcher;
  const useCache = !deps.fetchPage;
  const stored = !deps.fetchPage ? getStoredRuntimePreferences() : {};

  let jsonBody: unknown = undefined;
  if (typeof init?.body === 'string' && init.body.trim()) {
    try {
      jsonBody = JSON.parse(init.body);
    } catch {
      jsonBody = undefined;
    }
  }

  return dispatchAnisyncApiRequest(
    pathWithQuery,
    {
      method: init?.method || 'GET',
      jsonBody,
    },
    {
      fetchHttp,
      serviceName: 'anisync-android',
      catalogPrefs: deps.catalogPrefs || stored.catalogPrefs,
      snapshotReader: deps.readSnapshot || defaultBrowserSnapshotReader,
      useCache,
    }
  );
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!input.startsWith('/api/')) {
    return window.fetch(input, init);
  }

  if (isNativeAndroidApp()) {
    await ensureProxyBaseUrl();
    const result = await routeNativeApiRequest(input, init);
    return jsonResponse(result.body, result.status);
  }

  const stored = getStoredRuntimePreferences();
  const catalogHeader = encodeCatalogConfigHeader(stored.catalogPrefs);
  if (!catalogHeader) {
    return window.fetch(input, init);
  }

  const headers = new Headers(init?.headers || {});
  headers.set('X-Anisync-Catalog-Config', catalogHeader);
  return window.fetch(input, { ...init, headers });
}
