/**
 * Lightweight zero-dependency formatter for video server labels.
 * Kept separate from HTML parsers so UI chunks like EpisodeWorkspace
 * never pull cheerio (~300 KB) into the browser bundle.
 */
export function formatServerLabel(raw: string | undefined, fallback = 'Servidor'): string {
  const cleaned = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
