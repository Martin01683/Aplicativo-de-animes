export const MPEG_TS_PACKET_SIZE = 188;
export const MPEG_TS_SYNC_BYTE = 0x47;
export const TS_PROBE_BUFFER_SIZE = 32768;

const DISGUISED_SEGMENT_PATH_RE =
  /\.(?:image|png|jpe?g|gif|webp|bmp|ico|svg|js|css|html?|txt)(?:$|\?)/i;

const DISGUISED_CONTENT_TYPE_RE =
  /^(?:image\/|text\/(?:plain|html|css|javascript)|application\/(?:javascript|x-javascript|octet-stream)|binary\/octet-stream)/i;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function isDisguisedSegmentUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const pathname = new URL(rawUrl).pathname;
    return DISGUISED_SEGMENT_PATH_RE.test(pathname);
  } catch {
    return DISGUISED_SEGMENT_PATH_RE.test(rawUrl);
  }
}

export function isDisguisedContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return DISGUISED_CONTENT_TYPE_RE.test(contentType.trim());
}

export function isStartAtZeroRange(rangeHeader: string | null | undefined): boolean {
  if (!rangeHeader || !rangeHeader.trim()) return true;
  return /^bytes=0-\d*$/i.test(rangeHeader.trim());
}

export function looksLikeM3u8Manifest(buf: Uint8Array, len = buf.length): boolean {
  let i = 0;
  if (len >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    i = 3;
  }
  while (i < len && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0d || buf[i] === 0x0a)) {
    i += 1;
  }
  if (len - i < 7) return false;
  return (
    buf[i] === 0x23 && // #
    buf[i + 1] === 0x45 && // E
    buf[i + 2] === 0x58 && // X
    buf[i + 3] === 0x54 && // T
    buf[i + 4] === 0x4d && // M
    buf[i + 5] === 0x33 && // 3
    buf[i + 6] === 0x55 // U
  );
}

function isValidTsPacketHeader(buf: Uint8Array, pos: number): boolean {
  if (buf[pos] !== MPEG_TS_SYNC_BYTE) return false;
  // transport_error_indicator (MSB of byte 1) must be 0
  if ((buf[pos + 1] & 0x80) !== 0) return false;
  // adaptation_field_control (bits 4..5 of byte 3) must not be 00 (reserved)
  if ((buf[pos + 3] & 0x30) === 0) return false;
  return true;
}

export function isValidMpegTsStart(
  buf: Uint8Array,
  len: number,
  offset: number,
  reachedEof: boolean,
  relaxedMinPackets = false
): boolean {
  if (offset < 0 || offset >= len) return false;
  const remaining = len - offset;

  if (remaining >= MPEG_TS_PACKET_SIZE * 5) {
    for (let k = 0; k < 5; k += 1) {
      if (!isValidTsPacketHeader(buf, offset + k * MPEG_TS_PACKET_SIZE)) {
        return false;
      }
    }
    return true;
  }

  if (reachedEof) {
    if (remaining < MPEG_TS_PACKET_SIZE * 2 || remaining % MPEG_TS_PACKET_SIZE !== 0) {
      return false;
    }
    const packetCount = remaining / MPEG_TS_PACKET_SIZE;
    for (let k = 0; k < packetCount; k += 1) {
      if (!isValidTsPacketHeader(buf, offset + k * MPEG_TS_PACKET_SIZE)) {
        return false;
      }
    }
    return true;
  }

  const requiredPackets = relaxedMinPackets ? 3 : 4;
  if (remaining >= MPEG_TS_PACKET_SIZE * requiredPackets) {
    for (let k = 0; k < requiredPackets; k += 1) {
      if (!isValidTsPacketHeader(buf, offset + k * MPEG_TS_PACKET_SIZE)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function hasPngMagic(buf: Uint8Array, len: number): boolean {
  if (len < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (buf[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

function findPngEndOffset(buf: Uint8Array, len: number): number {
  if (!hasPngMagic(buf, len)) return -1;
  // Search for "IEND" chunk type (49 45 4E 44) followed by 4-byte CRC
  for (let i = 8; i + 8 <= len; i += 1) {
    if (
      buf[i] === 0x49 &&
      buf[i + 1] === 0x45 &&
      buf[i + 2] === 0x4e &&
      buf[i + 3] === 0x44
    ) {
      return i + 8;
    }
  }
  return -1;
}

/**
 * Detects whether a segment buffer contains a valid MPEG-TS stream, either at offset 0
 * or preceded by a disguised image/wrapper header (e.g. a 68-byte 1x1 PNG used by KojimaCDN).
 * Returns the byte offset where MPEG-TS sync packets begin, or -1 if not MPEG-TS.
 */
export function findMpegTsSyncOffset(
  buf: Uint8Array,
  len = buf.length,
  reachedEof = false
): number {
  if (len < MPEG_TS_PACKET_SIZE * 2) return -1;

  // 1. Clean MPEG-TS starting at byte 0
  if (isValidMpegTsStart(buf, len, 0, reachedEof, true)) {
    return 0;
  }

  // 2. Fast path: PNG-disguised segment (e.g. 68-byte 1x1 PNG ending with IEND + CRC)
  const pngEnd = findPngEndOffset(buf, len);
  if (pngEnd > 0 && isValidMpegTsStart(buf, len, pngEnd, reachedEof, true)) {
    return pngEnd;
  }

  // 3. General scan for any fake header (GIF, JPEG, WebP, BMP, custom padding)
  const maxOffset = len - MPEG_TS_PACKET_SIZE * 2;
  for (let i = 1; i <= maxOffset; i += 1) {
    if (buf[i] !== MPEG_TS_SYNC_BYTE) continue;
    if (isValidMpegTsStart(buf, len, i, reachedEof, false)) {
      return i;
    }
  }

  return -1;
}

/**
 * Rewrites a `Content-Range: bytes 0-<end>/<total>` header after stripping `stripBytes`
 * from the start of a segment. Returns null if the range did not start at byte 0 or is malformed.
 */
export function adjustContentRangeForStrip(
  contentRange: string | null | undefined,
  stripBytes: number
): string | null {
  if (!contentRange || stripBytes <= 0) return null;
  const match = contentRange.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (start !== 0 || end < stripBytes) return null;
  const newEnd = end - stripBytes;
  if (match[3] === '*') {
    return `bytes 0-${newEnd}/*`;
  }
  const total = Number.parseInt(match[3], 10);
  if (!Number.isFinite(total) || total <= stripBytes) return null;
  return `bytes 0-${newEnd}/${total - stripBytes}`;
}
