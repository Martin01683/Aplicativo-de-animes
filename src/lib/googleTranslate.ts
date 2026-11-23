import type { HttpFetcher } from './httpTypes.ts';

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

export function cleanSynopsisWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits long text into translation-safe chunks (preserving paragraphs and sentences)
 * so Google Translate GET URLs stay well under URI length limits.
 */
export function splitTextForTranslation(text: string, maxChunkChars = 1400): string[] {
  const normalized = cleanSynopsisWhitespace(text);
  if (!normalized) return [];
  if (normalized.length <= maxChunkChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
  };

  for (const rawPara of paragraphs) {
    const para = rawPara.trim();
    if (!para) continue;

    if (para.length <= maxChunkChars) {
      if (!current) {
        current = para;
      } else if (current.length + 2 + para.length <= maxChunkChars) {
        current = `${current}\n\n${para}`;
      } else {
        flush();
        current = para;
      }
      continue;
    }

    // Split oversized paragraph by sentence boundaries
    flush();
    const sentences = para.split(/(?<=[.!?])\s+/);
    let sentenceBuf = '';
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      if (sentence.length > maxChunkChars) {
        if (sentenceBuf) {
          chunks.push(sentenceBuf.trim());
          sentenceBuf = '';
        }
        for (let i = 0; i < sentence.length; i += maxChunkChars) {
          chunks.push(sentence.slice(i, i + maxChunkChars).trim());
        }
      } else if (!sentenceBuf) {
        sentenceBuf = sentence;
      } else if (sentenceBuf.length + 1 + sentence.length <= maxChunkChars) {
        sentenceBuf = `${sentenceBuf} ${sentence}`;
      } else {
        chunks.push(sentenceBuf.trim());
        sentenceBuf = sentence;
      }
    }
    if (sentenceBuf.trim()) {
      chunks.push(sentenceBuf.trim());
    }
  }

  flush();
  return chunks;
}

/**
 * Extracts translated text from Google Translate's `translate_a/single` JSON payload.
 * Returns empty string on malformed or empty payloads.
 */
export function parseGoogleTranslateResponse(rawJson: string): string {
  if (!rawJson || !rawJson.trim()) return '';
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) return '';
    const segments: string[] = [];
    for (const item of parsed[0]) {
      if (Array.isArray(item) && typeof item[0] === 'string' && item[0].length > 0) {
        segments.push(item[0]);
      }
    }
    return cleanSynopsisWhitespace(segments.join(''));
  } catch {
    return '';
  }
}

/**
 * Translates English text to Brazilian Portuguese via Google Translate.
 * Returns `null` if any request fails or yields an empty translation so callers
 * can safely fall back to the original English text.
 */
export async function translateEnglishToPtBr(
  fetchHttp: HttpFetcher,
  englishText: string
): Promise<string | null> {
  const chunks = splitTextForTranslation(englishText);
  if (chunks.length === 0) return null;

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    const queryUrl =
      `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=en&tl=pt-BR&dt=t&q=${encodeURIComponent(chunk)}`;
    try {
      const res = await fetchHttp(queryUrl, {
        accept: 'application/json, text/plain, */*',
        timeoutMs: 6000,
      });
      if (!res.ok) return null;
      const translated = parseGoogleTranslateResponse(res.body);
      if (!translated) return null;
      translatedChunks.push(translated);
    } catch {
      return null;
    }
  }

  const joined = cleanSynopsisWhitespace(translatedChunks.join('\n\n'));
  return joined || null;
}
