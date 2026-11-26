import type { StreamQuality, SubtitleTrack } from './types.ts';
import { isSafeExternalHttpUrl } from './urlSafety.ts';

const ABYSS_HOST_RE = /(?:^|\.)(?:abyssplayer\.com|abyss\.to|abysscdn\.com|short\.icu)$/i;
const ABYSS_DATAS_RE = /\b(?:const|let|var)\s+datas\s*=\s*["']([A-Za-z0-9+/=_-]{24,})["']/;

// ── Pure TypeScript RFC 1321 MD5 (works identically in Node & all browsers) ──

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
);

export function md5Bytes(input: Uint8Array): string {
  const origLen = input.length;
  const bitLen = origLen * 8;
  const paddedLen = (((origLen + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(input);
  buf[origLen] = 0x80;

  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      M[i] = view.getUint32(offset + i * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i += 1) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      const sum = (A + F + MD5_K[i] + M[g]) >>> 0;
      const s = MD5_SHIFTS[i];
      const rot = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rot) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);

  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    hex += out[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function md5Utf8(str: string): string {
  return md5Bytes(new TextEncoder().encode(str));
}

/**
 * Matches the numeric-argument quirk of the JS md5 library used by Abyss's bundle:
 * passing a JS Number (the file size) converts it via `.toString()` AFTER the String->bytes check,
 * so each decimal digit character '0'..'9' is coerced numerically to byte 0..9 instead of ASCII 48..57.
 */
export function md5AbyssNumericQuirk(size: number): string {
  const text = String(Math.trunc(size));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[i] = code >= 48 && code <= 57 ? code - 48 : 0;
  }
  return md5Bytes(bytes);
}

// ── Pure TypeScript FIPS-197 AES-256-CTR (128-bit big-endian counter) ────────

const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const AES_RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(b: number): number {
  return ((b << 1) ^ ((b & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
}

function expandAes256Key(key: Uint8Array): Uint8Array {
  const rk = new Uint8Array(240); // 15 round keys * 16 bytes
  rk.set(key.subarray(0, 32), 0);

  let bytesGenerated = 32;
  let rconIter = 1;
  const temp = new Uint8Array(4);

  while (bytesGenerated < 240) {
    temp[0] = rk[bytesGenerated - 4];
    temp[1] = rk[bytesGenerated - 3];
    temp[2] = rk[bytesGenerated - 2];
    temp[3] = rk[bytesGenerated - 1];

    if (bytesGenerated % 32 === 0) {
      const t = temp[0];
      temp[0] = AES_SBOX[temp[1]] ^ AES_RCON[rconIter++];
      temp[1] = AES_SBOX[temp[2]];
      temp[2] = AES_SBOX[temp[3]];
      temp[3] = AES_SBOX[t];
    } else if (bytesGenerated % 32 === 16) {
      temp[0] = AES_SBOX[temp[0]];
      temp[1] = AES_SBOX[temp[1]];
      temp[2] = AES_SBOX[temp[2]];
      temp[3] = AES_SBOX[temp[3]];
    }

    for (let i = 0; i < 4; i += 1) {
      rk[bytesGenerated] = rk[bytesGenerated - 32] ^ temp[i];
      bytesGenerated += 1;
    }
  }
  return rk;
}

function aes256EncryptBlock(block: Uint8Array, rk: Uint8Array): Uint8Array {
  const s = new Uint8Array(block);

  // Initial AddRoundKey
  for (let i = 0; i < 16; i += 1) s[i] ^= rk[i];

  for (let round = 1; round <= 14; round += 1) {
    // SubBytes
    for (let i = 0; i < 16; i += 1) s[i] = AES_SBOX[s[i]];

    // ShiftRows (column-major state)
    let tmp = s[1];
    s[1] = s[5];
    s[5] = s[9];
    s[9] = s[13];
    s[13] = tmp;

    tmp = s[2];
    const tmp2 = s[6];
    s[2] = s[10];
    s[6] = s[14];
    s[10] = tmp;
    s[14] = tmp2;

    tmp = s[15];
    s[15] = s[11];
    s[11] = s[7];
    s[7] = s[3];
    s[3] = tmp;

    // MixColumns (skip on final round 14)
    if (round < 14) {
      for (let col = 0; col < 16; col += 4) {
        const a0 = s[col];
        const a1 = s[col + 1];
        const a2 = s[col + 2];
        const a3 = s[col + 3];
        const u = a0 ^ a1 ^ a2 ^ a3;
        s[col] ^= u ^ xtime(a0 ^ a1);
        s[col + 1] ^= u ^ xtime(a1 ^ a2);
        s[col + 2] ^= u ^ xtime(a2 ^ a3);
        s[col + 3] ^= u ^ xtime(a3 ^ a0);
      }
    }

    // AddRoundKey
    const rkOff = round * 16;
    for (let i = 0; i < 16; i += 1) s[i] ^= rk[rkOff + i];
  }

  return s;
}

export function aes256CtrCrypt(
  input: Uint8Array,
  key32: Uint8Array,
  iv16: Uint8Array
): Uint8Array {
  const rk = expandAes256Key(key32);
  const counter = new Uint8Array(16);
  counter.set(iv16.subarray(0, 16), 0);
  const out = new Uint8Array(input.length);

  for (let offset = 0; offset < input.length; offset += 16) {
    const keystream = aes256EncryptBlock(counter, rk);
    const blockLen = Math.min(16, input.length - offset);
    for (let i = 0; i < blockLen; i += 1) {
      out[offset + i] = input[offset + i] ^ keystream[i];
    }
    // Increment 128-bit big-endian counter
    for (let i = 15; i >= 0; i -= 1) {
      counter[i] = (counter[i] + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  }
  return out;
}

// ── Byte-accurate Base64 helpers (no Buffer dependency) ──────────────────────

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_CHARS.length; i += 1) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

function base64ToBytes(raw: string): Uint8Array {
  const clean = raw.replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const len = clean.length;
  let pad = 0;
  if (len > 0 && clean[len - 1] === '=') pad += 1;
  if (len > 1 && clean[len - 2] === '=') pad += 1;
  const outLen = Math.max(0, ((len * 3) >> 2) - pad);
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  for (let i = 0; i < len; i += 4) {
    const c0 = clean.charCodeAt(i);
    const c1 = i + 1 < len ? clean.charCodeAt(i + 1) : 61;
    const c2 = i + 2 < len ? clean.charCodeAt(i + 2) : 61;
    const c3 = i + 3 < len ? clean.charCodeAt(i + 3) : 61;
    const v0 = c0 < 128 ? B64_LOOKUP[c0] : -1;
    const v1 = c1 < 128 ? B64_LOOKUP[c1] : -1;
    const v2 = c2 < 128 && c2 !== 61 ? B64_LOOKUP[c2] : 0;
    const v3 = c3 < 128 && c3 !== 61 ? B64_LOOKUP[c3] : 0;
    if (v0 < 0 || v1 < 0) break;
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (outIdx < outLen) out[outIdx++] = (triple >>> 16) & 0xff;
    if (outIdx < outLen && c2 !== 61) out[outIdx++] = (triple >>> 8) & 0xff;
    if (outIdx < outLen && c3 !== 61) out[outIdx++] = triple & 0xff;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(triple >>> 18) & 63];
    out += B64_CHARS[(triple >>> 12) & 63];
    out += i + 1 < len ? B64_CHARS[(triple >>> 6) & 63] : '=';
    out += i + 2 < len ? B64_CHARS[triple & 63] : '=';
  }
  return out;
}

function bytesToLatin1String(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const slice = bytes.subarray(i, Math.min(i + 8192, bytes.length));
    let s = '';
    for (let j = 0; j < slice.length; j += 1) {
      s += String.fromCharCode(slice[j]);
    }
    chunks.push(s);
  }
  return chunks.join('');
}

function latin1StringToBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

// ── Abyss / Aniplay protocol decoder ─────────────────────────────────────────

export interface AbyssMp4SourceItem {
  label?: string;
  res_id?: number;
  size?: number;
  codec?: string;
  status?: boolean;
  sub?: string;
  path?: string;
  file?: string;
}

export interface AbyssMediaPayload {
  mp4?: {
    sources?: AbyssMp4SourceItem[];
    domains?: string[];
  };
}

export interface AbyssDatasPayload {
  slug?: string;
  md5_id?: number | string;
  user_id?: number | string;
  media?: string | AbyssMediaPayload;
  config?: {
    poster?: boolean;
    subtitles?: Array<{
      lang?: string;
      slug?: string;
      type?: string;
    }>;
  };
}

export function isAbyssEmbedUrl(rawUrl: string): boolean {
  try {
    return ABYSS_HOST_RE.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

export function decryptAbyssMediaPayload(datas: AbyssDatasPayload): AbyssMediaPayload | null {
  if (!datas || !datas.media) return null;
  if (typeof datas.media === 'object') {
    return datas.media;
  }
  if (typeof datas.media !== 'string') return null;
  if (datas.user_id == null || !datas.slug || datas.md5_id == null) return null;

  try {
    const secret = `${datas.user_id}:${datas.slug}:${datas.md5_id}`;
    const keyBytes = new TextEncoder().encode(md5Utf8(secret));
    const ivBytes = keyBytes.subarray(0, 16);
    const cipherBytes = latin1StringToBytes(datas.media);
    const plainBytes = aes256CtrCrypt(cipherBytes, keyBytes, ivBytes);
    const plainJson = new TextDecoder('utf-8').decode(plainBytes);
    const parsed = JSON.parse(plainJson) as AbyssMediaPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function encryptAbyssSoraToken(plainPath: string, size: number): string {
  const keyBytes = new TextEncoder().encode(md5AbyssNumericQuirk(size));
  const ivBytes = keyBytes.subarray(0, 16);
  const encBytes = aes256CtrCrypt(new TextEncoder().encode(plainPath), keyBytes, ivBytes);
  const b1 = bytesToBase64(encBytes).replace(/=/g, '');
  const b2 = bytesToBase64(latin1StringToBytes(b1)).replace(/=/g, '');
  return b2;
}

function parseAbyssHeight(label?: string): number {
  const match = String(label || '').match(/(\d{3,4})p?/i);
  if (match) {
    const h = Number.parseInt(match[1], 10);
    if (Number.isFinite(h) && h > 0) return h;
  }
  return 0;
}

function safeDecodeLabel(raw: string | undefined): string {
  if (!raw) return 'Legenda';
  try {
    return decodeURIComponent(raw).trim() || 'Legenda';
  } catch {
    return raw.trim() || 'Legenda';
  }
}

export function extractAbyssStreamsFromHtml(
  embedUrl: string,
  html: string
): {
  streams: StreamQuality[];
  subtitles: SubtitleTrack[];
  poster?: string;
  provider: 'Aniplay';
} | null {
  if (!html) return null;
  const match = html.match(ABYSS_DATAS_RE);
  if (!match?.[1]) return null;

  let datas: AbyssDatasPayload;
  try {
    const rawLatin1 = bytesToLatin1String(base64ToBytes(match[1]));
    datas = JSON.parse(rawLatin1) as AbyssDatasPayload;
  } catch {
    return null;
  }

  const media = decryptAbyssMediaPayload(datas);
  if (!media?.mp4) return null;

  const rawSources = Array.isArray(media.mp4.sources) ? media.mp4.sources : [];
  const domains = Array.isArray(media.mp4.domains) ? media.mp4.domains : [];
  const totalCount = rawSources.length;

  // Group sources by quality label, preferring h264 over av1 and active status over inactive
  const grouped = new Map<string, AbyssMp4SourceItem[]>();
  for (const src of rawSources) {
    if (!src || !src.label) continue;
    const label = String(src.label).trim();
    if (!label) continue;
    if (label === 'origin' && totalCount > 1) continue;
    if (label === '1440p' || label === '2160p') continue;
    const list = grouped.get(label) || [];
    list.push(src);
    grouped.set(label, list);
  }

  const streams: StreamQuality[] = [];
  for (const [label, candidates] of grouped.entries()) {
    const ranked = [...candidates].sort((a, b) => {
      const aAv1 = a.codec === 'av1' ? 0 : 1;
      const bAv1 = b.codec === 'av1' ? 0 : 1;
      if (bAv1 !== aAv1) return bAv1 - aAv1;
      const aScore = a.path ? 2 : a.status ? 1 : 0;
      const bScore = b.path ? 2 : b.status ? 1 : 0;
      return bScore - aScore;
    });
    const best = ranked[0];
    if (!best) continue;

    let streamUrl = '';
    if (best.size && best.res_id != null && best.sub && datas.md5_id != null && datas.slug) {
      const domain = domains.find((d) => typeof d === 'string' && d.includes(best.sub!));
      if (domain) {
        const plainPath = `/mp4/${datas.md5_id}/${best.res_id}/${best.size}?v=${datas.slug}`;
        const token = encryptAbyssSoraToken(plainPath, Number(best.size));
        if (token) {
          streamUrl = `https://${domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}/sora/${best.size}/${token}`;
        }
      }
    } else if (best.file && isSafeExternalHttpUrl(best.file)) {
      streamUrl = best.file;
    }

    if (streamUrl && isSafeExternalHttpUrl(streamUrl)) {
      const height = parseAbyssHeight(label);
      streams.push({
        label: height > 0 ? `${height}p` : label,
        height,
        url: streamUrl,
        format: 'mp4',
      });
    }
  }

  streams.sort((a, b) => b.height - a.height);

  const subtitles: SubtitleTrack[] = [];
  const subList = Array.isArray(datas.config?.subtitles) ? datas.config.subtitles : [];
  for (const sub of subList) {
    if (!sub?.slug || !sub?.type || datas.md5_id == null) continue;
    const subUrl = `https://cdn.iamcdn.net/subtitle/${datas.md5_id}/${sub.slug}.${sub.type}`;
    if (!isSafeExternalHttpUrl(subUrl)) continue;
    const label = safeDecodeLabel(sub.lang);
    subtitles.push({
      label,
      url: subUrl,
      isDefault: /portugu[eê]s|pt[-_ ]?br|brasil|brazil/i.test(label),
    });
  }

  let poster: string | undefined;
  try {
    const parsedUrl = new URL(embedUrl);
    const qThumb = parsedUrl.searchParams.get('thumbnail') || parsedUrl.searchParams.get('image');
    if (qThumb && isSafeExternalHttpUrl(qThumb)) {
      poster = qThumb;
    }
    const qSub = parsedUrl.searchParams.get('sub') || parsedUrl.searchParams.get('subtitle');
    if (qSub && isSafeExternalHttpUrl(qSub)) {
      const qLang =
        parsedUrl.searchParams.get('lang') || parsedUrl.searchParams.get('sub-lang') || 'Legenda';
      subtitles.unshift({
        label: safeDecodeLabel(qLang),
        url: `https://cdn.iamcdn.net/proxy/subtitle?url=${encodeURIComponent(qSub)}`,
        isDefault: true,
      });
    }
  } catch {
    // ignore malformed query string
  }

  if (!poster && datas.config?.poster && datas.slug) {
    poster = `https://img.freeimagecdn.net/image/${datas.slug}.jpg`;
  }

  return {
    streams,
    subtitles,
    poster,
    provider: 'Aniplay',
  };
}
