export interface HttpFetchOptions {
  method?: 'GET' | 'POST' | 'PROPFIND';
  referer?: string;
  accept?: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpFetchResult {
  status: number;
  ok: boolean;
  finalUrl: string;
  body: string;
  retryAfter?: string;
}

export type HttpFetcher = (url: string, options?: HttpFetchOptions) => Promise<HttpFetchResult>;
