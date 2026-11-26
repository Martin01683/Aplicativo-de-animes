import crypto from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import tls from 'node:tls';
import {
  IDLE_TV_CAST_STATE,
  dedupeCastDevices,
  type TvCastDeliveryPreference,
  type TvCastDevice,
  type TvCastMediaPayload,
  type TvCastStateSnapshot,
} from './tvCast.ts';
import { isSafeExternalHttpUrl } from './urlSafety.ts';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

export const CHROMECAST_DEFAULT_APP_ID = 'CC1AD845';
export const CAST_NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
export const CAST_NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
export const CAST_NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
export const CAST_NS_MEDIA = 'urn:x-cast:com.google.cast.media';

export const UPNP_AV_TRANSPORT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';
export const UPNP_RENDERING_CONTROL_SERVICE = 'urn:schemas-upnp-org:service:RenderingControl:1';
export const UPNP_MEDIA_RENDERER_DEVICE = 'urn:schemas-upnp-org:device:MediaRenderer:1';

const M3U8_EXT_RE = /\.m3u8(?:$|\?)/i;

// -----------------------------------------------------------------------------
// Pure Protocol Codecs (Cast V2 Protobuf, mDNS DNS-SD, SSDP/UPnP, DIDL-Lite, VTT)
// -----------------------------------------------------------------------------

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, startPos: number): { value: number; nextPos: number } {
  let result = 0;
  let shift = 0;
  let pos = startPos;
  while (pos < buf.length && shift < 35) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: result >>> 0, nextPos: pos };
    }
    shift += 7;
  }
  throw new Error('Malformed protobuf varint');
}

function writeStringField(fieldNumber: number, value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

export interface CastV2Packet {
  protocolVersion: number;
  sourceId: string;
  destinationId: string;
  namespace: string;
  payloadType: number;
  payloadUtf8: string;
}

export function encodeCastV2Message(
  sourceId: string,
  destinationId: string,
  namespace: string,
  payloadUtf8: string
): Buffer {
  const parts: Buffer[] = [
    encodeVarint((1 << 3) | 0),
    encodeVarint(0),
    writeStringField(2, sourceId),
    writeStringField(3, destinationId),
    writeStringField(4, namespace),
    encodeVarint((5 << 3) | 0),
    encodeVarint(0),
    writeStringField(6, payloadUtf8),
  ];
  return Buffer.concat(parts);
}

export function decodeCastV2Message(buf: Buffer): CastV2Packet {
  let protocolVersion = 0;
  let sourceId = '';
  let destinationId = '';
  let namespace = '';
  let payloadType = 0;
  let payloadUtf8 = '';

  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    pos = tagRes.nextPos;
    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x07;

    if (wireType === 0) {
      const valRes = readVarint(buf, pos);
      pos = valRes.nextPos;
      if (fieldNumber === 1) protocolVersion = valRes.value;
      else if (fieldNumber === 5) payloadType = valRes.value;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, pos);
      pos = lenRes.nextPos;
      const slice = buf.subarray(pos, pos + lenRes.value);
      pos += lenRes.value;
      if (fieldNumber === 2) sourceId = slice.toString('utf8');
      else if (fieldNumber === 3) destinationId = slice.toString('utf8');
      else if (fieldNumber === 4) namespace = slice.toString('utf8');
      else if (fieldNumber === 6) payloadUtf8 = slice.toString('utf8');
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }

  return { protocolVersion, sourceId, destinationId, namespace, payloadType, payloadUtf8 };
}

export function frameCastV2Message(payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function encodeDnsName(name: string): Buffer {
  const labels = name
    .replace(/\.$/, '')
    .split('.')
    .filter(Boolean);
  const chunks: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, 'utf8');
    chunks.push(Buffer.from([b.length]), b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function buildMdnsQueryPacket(name: string, qtype = 12, unicastResponse = true): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID
  header.writeUInt16BE(0, 2); // Standard query
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  const qname = encodeDnsName(name);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt16BE(qtype, 0);
  trailer.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2);
  return Buffer.concat([header, qname, trailer]);
}

function readDnsName(buf: Buffer, startOffset: number): { name: string; nextOffset: number } {
  const labels: string[] = [];
  let offset = startOffset;
  let jumped = false;
  let endOffset = startOffset;
  let guard = 0;

  while (offset < buf.length && guard < 64) {
    guard += 1;
    const len = buf[offset];
    if (len === 0) {
      if (!jumped) endOffset = offset + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) break;
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) endOffset = offset + 2;
      offset = ptr;
      jumped = true;
      continue;
    }
    offset += 1;
    if (offset + len > buf.length) break;
    labels.push(buf.subarray(offset, offset + len).toString('utf8'));
    offset += len;
    if (!jumped) endOffset = offset;
  }

  return { name: labels.join('.'), nextOffset: endOffset };
}

export interface ParsedMdnsPacket {
  ptrs: Array<{ name: string; target: string }>;
  srvs: Array<{ name: string; port: number; target: string }>;
  txts: Array<{ name: string; attrs: Record<string, string> }>;
  aRecords: Array<{ name: string; ip: string }>;
}

export function parseMdnsResponsePacket(buf: Buffer): ParsedMdnsPacket {
  const out: ParsedMdnsPacket = { ptrs: [], srvs: [], txts: [], aRecords: [] };
  if (buf.length < 12) return out;

  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);

  let offset = 12;
  for (let i = 0; i < qdCount && offset < buf.length; i += 1) {
    const q = readDnsName(buf, offset);
    offset = q.nextOffset + 4;
  }

  const totalRr = anCount + nsCount + arCount;
  for (let i = 0; i < totalRr && offset + 10 <= buf.length; i += 1) {
    const rrName = readDnsName(buf, offset);
    offset = rrName.nextOffset;
    if (offset + 10 > buf.length) break;

    const rtype = buf.readUInt16BE(offset);
    const rdlength = buf.readUInt16BE(offset + 8);
    const rdataStart = offset + 10;
    const rdataEnd = rdataStart + rdlength;
    if (rdataEnd > buf.length) break;

    if (rtype === 12) {
      // PTR
      const target = readDnsName(buf, rdataStart).name;
      if (target) out.ptrs.push({ name: rrName.name, target });
    } else if (rtype === 33 && rdlength >= 6) {
      // SRV
      const port = buf.readUInt16BE(rdataStart + 4);
      const target = readDnsName(buf, rdataStart + 6).name;
      if (target) out.srvs.push({ name: rrName.name, port, target });
    } else if (rtype === 16) {
      // TXT
      const attrs: Record<string, string> = {};
      let p = rdataStart;
      while (p < rdataEnd) {
        const l = buf[p++];
        if (l <= 0 || p + l > rdataEnd) break;
        const entry = buf.subarray(p, p + l).toString('utf8');
        p += l;
        const eq = entry.indexOf('=');
        if (eq > 0) {
          attrs[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }
      out.txts.push({ name: rrName.name, attrs });
    } else if (rtype === 1 && rdlength === 4) {
      // A
      const ip = `${buf[rdataStart]}.${buf[rdataStart + 1]}.${buf[rdataStart + 2]}.${buf[rdataStart + 3]}`;
      out.aRecords.push({ name: rrName.name, ip });
    }

    offset = rdataEnd;
  }

  return out;
}

export function isChromecastVideoCapable(caRaw?: string): boolean {
  if (!caRaw || !caRaw.trim()) return true;
  const parsed = Number.parseInt(caRaw.trim(), 10);
  if (!Number.isFinite(parsed)) return true;
  return (parsed & 1) !== 0;
}

export function escapeXml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(raw: string): string {
  return String(raw || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function extractXmlTagValue(xml: string, localTag: string): string {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${localTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${localTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`,
    'i'
  );
  const m = xml.match(re);
  return m?.[1]?.trim() || '';
}

export function parseSsdpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return headers;
}

export function parseUpnpDeviceXml(xml: string, locationUrl: string): TvCastDevice | null {
  if (!xml.trim() || !locationUrl.trim()) return null;
  const urlBase = extractXmlTagValue(xml, 'URLBase') || locationUrl.trim();

  let avControl = '';
  let rcControl = '';

  const serviceRe = /<(?:[\w-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?service>/gi;
  let match: RegExpExecArray | null;
  while ((match = serviceRe.exec(xml)) !== null) {
    const block = match[1];
    const svcType = extractXmlTagValue(block, 'serviceType').toLowerCase();
    const ctrl = extractXmlTagValue(block, 'controlURL');
    if (!svcType || !ctrl) continue;
    try {
      const resolved = new URL(ctrl, urlBase).href;
      if (!avControl && svcType.includes('avtransport')) {
        avControl = resolved;
      } else if (!rcControl && svcType.includes('renderingcontrol')) {
        rcControl = resolved;
      }
    } catch {
      // ignore malformed URL
    }
  }

  if (!avControl) return null;

  const friendlyName = unescapeXml(extractXmlTagValue(xml, 'friendlyName'));
  const manufacturer = unescapeXml(extractXmlTagValue(xml, 'manufacturer'));
  const model = unescapeXml(extractXmlTagValue(xml, 'modelName'));
  const udn = extractXmlTagValue(xml, 'UDN');

  let loc: URL;
  try {
    loc = new URL(locationUrl.trim());
  } catch {
    return null;
  }
  const host = loc.hostname;
  const port = loc.port ? Number.parseInt(loc.port, 10) : 80;

  if (!host) return null;

  return {
    id: udn ? `dlna:${udn}` : `dlna:${host}:${port}`,
    name: friendlyName || model || `Smart TV (${host})`,
    manufacturer,
    model,
    host,
    port,
    protocol: 'dlna',
    avTransportControlUrl: avControl,
    renderingControlUrl: rcControl,
    locationUrl: locationUrl.trim(),
  };
}

export function buildDidlLiteMetadata(params: {
  title: string;
  seriesTitle?: string;
  poster?: string;
  mediaUrl: string;
  mimeType: string;
}): string {
  const safeTitle = escapeXml(params.title || 'Anisync');
  const safeSeries = escapeXml(params.seriesTitle || '');
  const safeMime = escapeXml(params.mimeType || 'video/mp4');
  const safeUrl = escapeXml(params.mediaUrl);

  let xml =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${safeTitle}</dc:title>`;
  if (safeSeries) {
    xml += `<upnp:seriesTitle>${safeSeries}</upnp:seriesTitle>`;
  }
  if (params.poster?.trim()) {
    xml += `<upnp:albumArtURI>${escapeXml(params.poster.trim())}</upnp:albumArtURI>`;
  }
  xml +=
    '<upnp:class>object.item.videoItem.movie</upnp:class>' +
    `<res protocolInfo="http-get:*:${safeMime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0">${safeUrl}</res>` +
    '</item></DIDL-Lite>';
  return xml;
}

export function buildSoapEnvelope(
  serviceType: string,
  action: string,
  args: Record<string, string>
): string {
  const bodyArgs = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${bodyArgs}</u:${action}></s:Body></s:Envelope>`
  );
}

export function formatDlnaTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function parseDlnaTimeMs(raw: string): number {
  const clean = (raw || '').trim();
  if (!clean || /^NOT_IMPLEMENTED$/i.test(clean)) return -1;
  const parts = clean.split(':');
  if (parts.length !== 3) return -1;
  const h = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  const s = Number.parseFloat(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s) || h < 0 || m < 0 || s < 0) {
    return -1;
  }
  return Math.round((h * 3600 + m * 60 + s) * 1000);
}

export function convertSrtToVtt(raw: string): string {
  const clean = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (clean.startsWith('WEBVTT')) return `${clean}\n`;
  const converted = clean.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g,
    '$1.$2$3$4.$5'
  );
  return `WEBVTT\n\n${converted}\n`;
}

export function rewriteM3u8ForServerLanProxy(
  manifest: string,
  baseManifestUrl: string,
  lanBaseUrl: string,
  token: string,
  referer: string
): string {
  const cleanBase = lanBaseUrl.replace(/\/+$/, '');
  const safeRef = isSafeExternalHttpUrl(referer) ? referer : 'https://topanimes.net/';
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_, rawUri: string) => {
          try {
            const abs = new URL(rawUri, baseManifestUrl).href;
            if (!isSafeExternalHttpUrl(abs)) return `URI="${rawUri}"`;
            const isNested = M3U8_EXT_RE.test(abs);
            const suffix = isNested ? 'playlist.m3u8' : 'stream.mp4';
            return `URI="${cleanBase}/api/tv-cast/media/${token}/${suffix}?url=${encodeURIComponent(
              abs
            )}&referer=${encodeURIComponent(safeRef)}"`;
          } catch {
            return `URI="${rawUri}"`;
          }
        });
      }
      try {
        const abs = new URL(trimmed, baseManifestUrl).href;
        if (!isSafeExternalHttpUrl(abs)) return line;
        const isNested = M3U8_EXT_RE.test(abs);
        const suffix = isNested ? 'playlist.m3u8' : 'segment.ts';
        return `${cleanBase}/api/tv-cast/media/${token}/${suffix}?url=${encodeURIComponent(
          abs
        )}&referer=${encodeURIComponent(safeRef)}${isNested ? '' : '&hls_seg=1'}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

// -----------------------------------------------------------------------------
// LAN Interface Helpers (handles Windows Wi-Fi vs WSL/Docker/VPN adapters)
// -----------------------------------------------------------------------------

interface LanInterfaceInfo {
  name: string;
  address: string;
  isVirtual: boolean;
}

const VIRTUAL_IFACE_RE = /(vethernet|wsl|docker|vmware|virtualbox|vbox|hyper-v|loopback|tailscale|zerotier|hamachi|tun|tap)/i;

function getLanIpv4Interfaces(): LanInterfaceInfo[] {
  const nets = os.networkInterfaces();
  const list: LanInterfaceInfo[] = [];
  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        list.push({
          name,
          address: info.address,
          isVirtual: VIRTUAL_IFACE_RE.test(name),
        });
      }
    }
  }
  return list.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual));
}

export function selectLanIpForDeviceHost(targetHost?: string): string {
  const ifaces = getLanIpv4Interfaces();
  if (!ifaces.length) return '';

  if (targetHost && /^\d+\.\d+\.\d+\.\d+$/.test(targetHost)) {
    const targetParts = targetHost.split('.');
    // Exact /24 match first
    const match24 = ifaces.find((iface) => {
      const p = iface.address.split('.');
      return p[0] === targetParts[0] && p[1] === targetParts[1] && p[2] === targetParts[2];
    });
    if (match24) return match24.address;

    // /16 match second
    const match16 = ifaces.find((iface) => {
      const p = iface.address.split('.');
      return p[0] === targetParts[0] && p[1] === targetParts[1];
    });
    if (match16) return match16.address;
  }

  // Prefer non-virtual 192.168.* or 10.* LAN interface
  const preferred =
    ifaces.find((i) => !i.isVirtual && /^(?:192\.168\.|10\.)/.test(i.address)) ||
    ifaces.find((i) => !i.isVirtual) ||
    ifaces[0];
  return preferred?.address || '';
}

// -----------------------------------------------------------------------------
// Live Discovery Engine (Simultaneous mDNS Chromecast + SSDP DLNA)
// -----------------------------------------------------------------------------

let cachedDiscoveredDevices: { devices: TvCastDevice[]; updatedAt: number } = {
  devices: [],
  updatedAt: 0,
};

async function discoverChromecastsViaMdns(timeoutMs: number): Promise<TvCastDevice[]> {
  const ifaces = getLanIpv4Interfaces();
  const bindTargets = ifaces.length > 0 ? ifaces.map((i) => i.address) : ['0.0.0.0'];

  const instances = new Set<string>();
  const srvByInstance = new Map<string, { port: number; target: string }>();
  const txtByInstance = new Map<string, Record<string, string>>();
  const ipByHost = new Map<string, string>();
  const sockets: dgram.Socket[] = [];

  const ingestPacket = (msg: Buffer, rinfoAddress: string, sock: dgram.Socket) => {
    const parsed = parseMdnsResponsePacket(msg);
    for (const a of parsed.aRecords) {
      ipByHost.set(a.name.toLowerCase(), a.ip);
    }
    for (const txt of parsed.txts) {
      const key = txt.name.toLowerCase();
      txtByInstance.set(key, { ...(txtByInstance.get(key) || {}), ...txt.attrs });
    }
    for (const srv of parsed.srvs) {
      const key = srv.name.toLowerCase();
      srvByInstance.set(key, { port: srv.port, target: srv.target.toLowerCase() });
      if (key.includes('_googlecast._tcp')) {
        instances.add(key);
        if (!ipByHost.has(srv.target.toLowerCase()) && rinfoAddress) {
          ipByHost.set(srv.target.toLowerCase(), rinfoAddress);
        }
      }
    }
    for (const ptr of parsed.ptrs) {
      if (ptr.name.toLowerCase().includes('_googlecast._tcp')) {
        const instKey = ptr.target.toLowerCase();
        if (!instances.has(instKey)) {
          instances.add(instKey);
          // Request SRV + TXT if receiver didn't bundle them in Additional records
          try {
            const srvQ = buildMdnsQueryPacket(ptr.target, 33, true);
            const txtQ = buildMdnsQueryPacket(ptr.target, 16, true);
            sock.send(srvQ, MDNS_PORT, MDNS_ADDR);
            sock.send(txtQ, MDNS_PORT, MDNS_ADDR);
          } catch {
            // ignore send failures
          }
        }
      }
    }
  };

  await new Promise<void>((resolve) => {
    const queryBuf = buildMdnsQueryPacket('_googlecast._tcp.local', 12, true);
    const multicastQueryBuf = buildMdnsQueryPacket('_googlecast._tcp.local', 12, false);
    let closed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Passive multicast listener on UDP 5353 (catches Chromecast/Android TVs that ignore QU bit
    // and reply strictly to 224.0.0.251:5353). Fails gracefully if OS holds 5353 exclusively.
    try {
      const mcastSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(mcastSock);
      mcastSock.on('error', () => {
        // ignore if port 5353 cannot be shared
      });
      mcastSock.on('message', (msg, rinfo) => {
        ingestPacket(msg, rinfo.address, mcastSock);
      });
      mcastSock.bind(MDNS_PORT, () => {
        for (const bindAddr of bindTargets) {
          try {
            if (bindAddr === '0.0.0.0') {
              mcastSock.addMembership(MDNS_ADDR);
            } else {
              mcastSock.addMembership(MDNS_ADDR, bindAddr);
            }
          } catch {
            // ignore per-interface membership errors
          }
        }
      });
    } catch {
      // ignore
    }

    for (const bindAddr of bindTargets) {
      try {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sockets.push(sock);

        sock.on('error', () => {
          // ignore per-interface errors
        });
        sock.on('message', (msg, rinfo) => {
          ingestPacket(msg, rinfo.address, sock);
        });
        sock.bind(0, bindAddr === '0.0.0.0' ? undefined : bindAddr, () => {
          try {
            if (bindAddr !== '0.0.0.0') {
              sock.setMulticastInterface(bindAddr);
            }
            sock.setMulticastTTL(255);
          } catch {
            // ignore
          }
          const sendQueries = () => {
            if (closed) return;
            try {
              sock.send(queryBuf, MDNS_PORT, MDNS_ADDR);
              sock.send(multicastQueryBuf, MDNS_PORT, MDNS_ADDR);
            } catch {
              // ignore
            }
          };
          sendQueries();
          timers.push(setTimeout(sendQueries, 650));
        });
      } catch {
        // ignore interface failure
      }
    }

    setTimeout(() => {
      closed = true;
      for (const t of timers) clearTimeout(t);
      for (const sock of sockets) {
        try {
          sock.close();
        } catch {
          // ignore
        }
      }
      resolve();
    }, timeoutMs);
  });

  const devices: TvCastDevice[] = [];
  for (const instKey of instances) {
    const srv = srvByInstance.get(instKey);
    const txt = txtByInstance.get(instKey) || {};
    const host = srv ? ipByHost.get(srv.target) || '' : '';
    if (!host) continue;
    if (!isChromecastVideoCapable(txt.ca)) continue;

    const port = srv?.port && srv.port > 0 ? srv.port : 8009;
    const rawInstanceLabel = instKey.split('._googlecast._tcp')[0] || host;
    const name = txt.fn?.trim() || rawInstanceLabel;
    const model = txt.md?.trim() || 'Chromecast / Android TV';
    const id = txt.id ? `cast:${txt.id}` : `cast:${host}:${port}`;

    devices.push({
      id,
      name,
      manufacturer: 'Google Cast',
      model,
      host,
      port,
      protocol: 'chromecast',
    });
  }

  return devices;
}

async function discoverDlnaTvsViaSsdp(timeoutMs: number): Promise<TvCastDevice[]> {
  const ifaces = getLanIpv4Interfaces();
  const bindTargets = ifaces.length > 0 ? ifaces.map((i) => i.address) : ['0.0.0.0'];
  const seenLocations = new Set<string>();
  const sockets: dgram.Socket[] = [];

  const buildSearch = (st: string) =>
    Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
      'utf8'
    );

  const probes = [
    buildSearch(UPNP_AV_TRANSPORT_SERVICE),
    buildSearch(UPNP_MEDIA_RENDERER_DEVICE),
    buildSearch('ssdp:all'),
  ];

  await new Promise<void>((resolve) => {
    for (const bindAddr of bindTargets) {
      try {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sockets.push(sock);
        sock.on('error', () => {
          // ignore
        });
        sock.on('message', (msg) => {
          const headers = parseSsdpHeaders(msg.toString('utf8'));
          if (headers.location && /^https?:\/\//i.test(headers.location)) {
            seenLocations.add(headers.location);
          }
        });
        sock.bind(0, bindAddr === '0.0.0.0' ? undefined : bindAddr, () => {
          try {
            if (bindAddr !== '0.0.0.0') {
              sock.setMulticastInterface(bindAddr);
            }
            sock.setMulticastTTL(2);
          } catch {
            // ignore
          }
          const sendAll = () => {
            for (const p of probes) {
              try {
                sock.send(p, SSDP_PORT, SSDP_ADDR);
              } catch {
                // ignore
              }
            }
          };
          sendAll();
          setTimeout(sendAll, 700);
        });
      } catch {
        // ignore
      }
    }

    setTimeout(() => {
      for (const sock of sockets) {
        try {
          sock.close();
        } catch {
          // ignore
        }
      }
      resolve();
    }, timeoutMs);
  });

  const fetched = await Promise.all(
    Array.from(seenLocations).map(async (locationUrl): Promise<TvCastDevice | null> => {
      try {
        const res = await fetch(locationUrl, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) return null;
        const xml = await res.text();
        return parseUpnpDeviceXml(xml, locationUrl);
      } catch {
        return null;
      }
    })
  );

  return fetched.filter((d): d is TvCastDevice => Boolean(d));
}

export async function discoverLanTvDevices(timeoutMs = 3600): Promise<TvCastDevice[]> {
  const clamped = Math.max(1500, Math.min(8000, timeoutMs));
  const [chromecasts, dlnaTvs] = await Promise.all([
    discoverChromecastsViaMdns(clamped),
    discoverDlnaTvsViaSsdp(clamped),
  ]);
  const merged = dedupeCastDevices([...chromecasts, ...dlnaTvs]);
  cachedDiscoveredDevices = { devices: merged, updatedAt: Date.now() };
  return merged;
}

export function getCachedLanTvDevices(): TvCastDevice[] {
  if (Date.now() - cachedDiscoveredDevices.updatedAt > 120_000) {
    return [];
  }
  return cachedDiscoveredDevices.devices;
}

// -----------------------------------------------------------------------------
// Active Server-Side TV Cast Session Controller (Chromecast V2 + DLNA SOAP)
// -----------------------------------------------------------------------------

interface ActiveServerCastSession {
  gen: number;
  token: string;
  device: TvCastDevice;
  media: TvCastMediaPayload;
  deliveryPreference: TvCastDeliveryPreference;
  attemptedDirectFallback: boolean;
  lanBaseUrl: string;
  lanStreamUrl: string;
  lanSubtitleUrl: string;
  state: TvCastStateSnapshot;
  pollTimer?: ReturnType<typeof setInterval>;
  // Chromecast state
  tlsSocket?: tls.TLSSocket;
  castBuffer?: Buffer;
  senderId?: string;
  reqSeq?: number;
  transportId?: string;
  appSessionId?: string;
  mediaSessionId?: number;
  mediaLoaded?: boolean;
  lastPingMs?: number;
  // DLNA state
  dlnaSawPlaying?: boolean;
}

let activeSession: ActiveServerCastSession | null = null;
let sessionGenCounter = 0;

export function getServerCastState(): TvCastStateSnapshot {
  return activeSession ? { ...activeSession.state } : { ...IDLE_TV_CAST_STATE };
}

export function getServerCastSessionByToken(token: string): {
  streamUrl: string;
  referer: string;
  subtitleUrl: string;
  streamFormat: string;
} | null {
  if (!activeSession || !token || activeSession.token !== token) return null;
  return {
    streamUrl: activeSession.media.streamUrl,
    referer: activeSession.media.referer || 'https://topanimes.net/',
    subtitleUrl: activeSession.media.subtitleUrl || '',
    streamFormat: activeSession.media.streamFormat || 'mp4',
  };
}

async function probeDirectPlayable(rawUrl: string): Promise<boolean> {
  if (!isSafeExternalHttpUrl(rawUrl)) return false;
  try {
    const res = await fetch(rawUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-4095', Accept: '*/*' },
      signal: AbortSignal.timeout(2800),
    });
    if (res.status !== 200 && res.status !== 206) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('text/') || ct.startsWith('image/') || ct.includes('html')) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 12) return false;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return false;
    if (buf[0] === 0x3c) return false;
    return true;
  } catch {
    return false;
  }
}

function sendCastJson(sess: ActiveServerCastSession, destination: string, namespace: string, payload: unknown): void {
  if (!sess.tlsSocket || sess.tlsSocket.destroyed) return;
  const encoded = encodeCastV2Message(
    sess.senderId || 'sender-anisync',
    destination,
    namespace,
    JSON.stringify(payload)
  );
  sess.tlsSocket.write(frameCastV2Message(encoded));
}

function sendChromecastLoad(sess: ActiveServerCastSession, urlToLoad: string): void {
  if (!sess.transportId) return;
  const isHls = sess.media.streamFormat === 'hls' || M3U8_EXT_RE.test(sess.media.streamUrl);
  const mimeType = isHls ? 'application/x-mpegurl' : 'video/mp4';

  const metadata: Record<string, unknown> = {
    metadataType: 0,
    title: sess.media.title || 'Anisync',
  };
  if (sess.media.seriesTitle) metadata.subtitle = sess.media.seriesTitle;
  if (sess.media.poster) metadata.images = [{ url: sess.media.poster }];

  const mediaObj: Record<string, unknown> = {
    contentId: urlToLoad,
    streamType: 'BUFFERED',
    contentType: mimeType,
    metadata,
  };

  const loadMsg: Record<string, unknown> = {
    type: 'LOAD',
    requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
    autoplay: true,
    media: mediaObj,
  };

  if (sess.media.startPositionMs && sess.media.startPositionMs > 1000) {
    loadMsg.currentTime = sess.media.startPositionMs / 1000;
  }

  if (sess.lanSubtitleUrl && sess.state.deliveryMode === 'background-proxy') {
    mediaObj.tracks = [
      {
        trackId: 1,
        type: 'TEXT',
        trackContentId: sess.lanSubtitleUrl,
        trackContentType: 'text/vtt',
        name: sess.media.subtitleLabel || 'Português',
        language: 'pt-BR',
        subtype: 'SUBTITLES',
      },
    ];
    loadMsg.activeTrackIds = [1];
  }

  sendCastJson(sess, sess.transportId, CAST_NS_MEDIA, loadMsg);
}

async function sendDlnaSoap(
  controlUrl: string,
  serviceType: string,
  action: string,
  args: Record<string, string>
): Promise<string> {
  const body = buildSoapEnvelope(serviceType, action, args);
  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${serviceType}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(5500),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TV DLNA retornou HTTP ${res.status} (${action})`);
  }
  return text;
}

function teardownSession(sess: ActiveServerCastSession | null, sendStopToTv: boolean): void {
  if (!sess) return;
  if (sess.pollTimer) {
    clearInterval(sess.pollTimer);
    sess.pollTimer = undefined;
  }
  if (sess.device.protocol === 'chromecast' && sess.tlsSocket) {
    if (sendStopToTv) {
      try {
        if (sess.transportId && typeof sess.mediaSessionId === 'number' && sess.mediaSessionId >= 0) {
          sendCastJson(sess, sess.transportId, CAST_NS_MEDIA, {
            type: 'STOP',
            mediaSessionId: sess.mediaSessionId,
            requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
          });
        } else if (sess.appSessionId) {
          sendCastJson(sess, 'receiver-0', CAST_NS_RECEIVER, {
            type: 'STOP',
            sessionId: sess.appSessionId,
            requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
          });
        }
      } catch {
        // ignore
      }
    }
    try {
      sess.tlsSocket.destroy();
    } catch {
      // ignore
    }
    sess.tlsSocket = undefined;
  } else if (sess.device.protocol === 'dlna' && sendStopToTv && sess.device.avTransportControlUrl) {
    void sendDlnaSoap(sess.device.avTransportControlUrl, UPNP_AV_TRANSPORT_SERVICE, 'Stop', {
      InstanceID: '0',
    }).catch(() => {});
  }
}

export async function stopServerTvCast(): Promise<TvCastStateSnapshot> {
  const prev = activeSession;
  activeSession = null;
  teardownSession(prev, true);
  return { ...IDLE_TV_CAST_STATE };
}

export async function startServerTvCast(params: {
  device: TvCastDevice;
  media: TvCastMediaPayload;
  serverPort: number;
  deliveryMode?: TvCastDeliveryPreference;
}): Promise<TvCastStateSnapshot> {
  const { device, media, serverPort } = params;
  if (!device?.host || !media?.streamUrl || !isSafeExternalHttpUrl(media.streamUrl)) {
    throw new Error('Dispositivo de TV ou stream inválido.');
  }

  const prev = activeSession;
  activeSession = null;
  teardownSession(prev, true);

  const gen = ++sessionGenCounter;
  const token = crypto.randomBytes(16).toString('hex');
  const lanIp = selectLanIpForDeviceHost(device.host);
  const lanBaseUrl = lanIp ? `http://${lanIp}:${serverPort}` : '';
  const isHls = media.streamFormat === 'hls' || M3U8_EXT_RE.test(media.streamUrl);
  const mimeType = isHls ? 'application/x-mpegurl' : 'video/mp4';
  const suffix = isHls ? 'playlist.m3u8' : 'stream.mp4';
  const safeRef = isSafeExternalHttpUrl(media.referer) ? media.referer : 'https://topanimes.net/';
  const lanStreamUrl = lanBaseUrl
    ? `${lanBaseUrl}/api/tv-cast/media/${token}/${suffix}?url=${encodeURIComponent(
        media.streamUrl
      )}&referer=${encodeURIComponent(safeRef)}`
    : '';
  const lanSubtitleUrl =
    lanBaseUrl && media.subtitleUrl ? `${lanBaseUrl}/api/tv-cast/media/${token}/subtitle.vtt` : '';

  const deliveryPref: TvCastDeliveryPreference = params.deliveryMode || 'auto';
  let chosenUrl = '';
  let chosenDelivery: 'direct' | 'background-proxy' = 'background-proxy';

  const canTryDirect =
    deliveryPref !== 'proxy' &&
    !isHls &&
    (!media.subtitleUrl || device.protocol === 'dlna');

  if (canTryDirect) {
    if (deliveryPref === 'direct' || (device.protocol === 'chromecast' && (await probeDirectPlayable(media.streamUrl)))) {
      chosenUrl = media.streamUrl;
      chosenDelivery = 'direct';
    }
  }

  if (!chosenUrl) {
    if (lanStreamUrl) {
      chosenUrl = lanStreamUrl;
      chosenDelivery = 'background-proxy';
    } else if (await probeDirectPlayable(media.streamUrl)) {
      chosenUrl = media.streamUrl;
      chosenDelivery = 'direct';
    } else {
      throw new Error('Não foi possível identificar o IP Wi-Fi local para transmitir à TV.');
    }
  }

  const sess: ActiveServerCastSession = {
    gen,
    token,
    device,
    media,
    deliveryPreference: deliveryPref,
    attemptedDirectFallback: false,
    lanBaseUrl,
    lanStreamUrl,
    lanSubtitleUrl,
    state: {
      active: true,
      status: 'connecting',
      deviceId: device.id,
      deviceName: device.name,
      deviceProtocol: device.protocol,
      deliveryMode: chosenDelivery,
      episodeUrl: media.episodeUrl || '',
      episodeTitle: media.title || 'Anisync',
      seriesTitle: media.seriesTitle || '',
      seriesUrl: media.seriesUrl || '',
      poster: media.poster || '',
      streamUrl: media.streamUrl,
      lanStreamUrl,
      positionMs: Math.max(0, media.startPositionMs || 0),
      durationMs: Math.max(0, media.durationMs || 0),
      volume: 1,
      muted: false,
      hasPrev: Boolean(media.prevUrl),
      hasNext: Boolean(media.nextUrl),
      errorMessage: '',
    },
  };
  activeSession = sess;

  if (device.protocol === 'dlna') {
    if (!device.avTransportControlUrl) {
      activeSession = null;
      throw new Error('URL de controle DLNA indisponível para esta TV.');
    }
    try {
      await sendDlnaSoap(device.avTransportControlUrl, UPNP_AV_TRANSPORT_SERVICE, 'Stop', {
        InstanceID: '0',
      }).catch(() => {});

      const loadDlna = async (urlToUse: string) => {
        const didl = buildDidlLiteMetadata({
          title: media.title || 'Anisync',
          seriesTitle: media.seriesTitle,
          poster: media.poster,
          mediaUrl: urlToUse,
          mimeType,
        });
        try {
          await sendDlnaSoap(device.avTransportControlUrl!, UPNP_AV_TRANSPORT_SERVICE, 'SetAVTransportURI', {
            InstanceID: '0',
            CurrentURI: urlToUse,
            CurrentURIMetaData: didl,
          });
        } catch {
          await sendDlnaSoap(device.avTransportControlUrl!, UPNP_AV_TRANSPORT_SERVICE, 'SetAVTransportURI', {
            InstanceID: '0',
            CurrentURI: urlToUse,
            CurrentURIMetaData: '',
          });
        }
        await sendDlnaSoap(device.avTransportControlUrl!, UPNP_AV_TRANSPORT_SERVICE, 'Play', {
          InstanceID: '0',
          Speed: '1',
        });
      };

      try {
        await loadDlna(chosenUrl);
      } catch (err) {
        if (chosenDelivery === 'direct' && lanStreamUrl) {
          sess.attemptedDirectFallback = true;
          sess.state.deliveryMode = 'background-proxy';
          await loadDlna(lanStreamUrl);
        } else {
          throw err;
        }
      }

      if (media.startPositionMs && media.startPositionMs > 2000) {
        setTimeout(() => {
          if (activeSession?.gen !== gen || !device.avTransportControlUrl) return;
          void sendDlnaSoap(device.avTransportControlUrl, UPNP_AV_TRANSPORT_SERVICE, 'Seek', {
            InstanceID: '0',
            Unit: 'REL_TIME',
            Target: formatDlnaTime(media.startPositionMs!),
          }).catch(() => {});
        }, 900);
      }

      sess.state.status = 'playing';
      sess.pollTimer = setInterval(() => {
        if (activeSession?.gen !== gen || !device.avTransportControlUrl) return;
        void (async () => {
          try {
            const tXml = await sendDlnaSoap(
              device.avTransportControlUrl!,
              UPNP_AV_TRANSPORT_SERVICE,
              'GetTransportInfo',
              { InstanceID: '0' }
            );
            const tState = extractXmlTagValue(tXml, 'CurrentTransportState').toUpperCase();
            const pXml = await sendDlnaSoap(
              device.avTransportControlUrl!,
              UPNP_AV_TRANSPORT_SERVICE,
              'GetPositionInfo',
              { InstanceID: '0' }
            );
            const rel = parseDlnaTimeMs(extractXmlTagValue(pXml, 'RelTime'));
            const dur = parseDlnaTimeMs(extractXmlTagValue(pXml, 'TrackDuration'));
            if (rel >= 0) sess.state.positionMs = rel;
            if (dur > 0) sess.state.durationMs = dur;

            if (tState === 'PLAYING') {
              sess.dlnaSawPlaying = true;
              sess.state.status = 'playing';
            } else if (tState === 'PAUSED_PLAYBACK') {
              sess.state.status = 'paused';
            } else if (tState === 'TRANSITIONING') {
              sess.state.status = 'buffering';
            } else if (
              (tState === 'STOPPED' || tState === 'NO_MEDIA_PRESENT') &&
              sess.dlnaSawPlaying &&
              sess.state.durationMs > 10_000 &&
              sess.state.positionMs >= sess.state.durationMs - 20_000
            ) {
              sess.state.status = 'stopped';
              sess.state.active = false;
              teardownSession(sess, false);
            }
          } catch {
            // ignore transient poll hiccups
          }
        })();
      }, 2000);

      return { ...sess.state };
    } catch (err) {
      activeSession = null;
      throw err;
    }
  }

  // Chromecast / Android TV via Cast V2 TLS (port 8009)
  sess.senderId = `sender-anisync-${Date.now() & 0xffff}`;
  sess.reqSeq = 1;
  sess.castBuffer = Buffer.alloc(0);
  sess.lastPingMs = Date.now();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const sock = tls.connect(
      {
        host: device.host,
        port: device.port || 8009,
        rejectUnauthorized: false,
      },
      () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }
    );

    sock.setTimeout(8000, () => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`Tempo esgotado ao conectar à TV ${device.name} (${device.host}).`));
      }
    });

    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Falha ao conectar à TV ${device.name}: ${err.message}`));
      } else if (activeSession?.gen === gen) {
        sess.state.status = 'error';
        sess.state.errorMessage = `Conexão perdida com ${device.name}.`;
      }
    });

    sock.on('data', (chunk: Buffer) => {
      if (activeSession?.gen !== gen) return;
      sess.castBuffer = Buffer.concat([sess.castBuffer || Buffer.alloc(0), chunk]);
      while (sess.castBuffer.length >= 4) {
        const msgLen = sess.castBuffer.readUInt32BE(0);
        if (msgLen <= 0 || msgLen > 2 * 1024 * 1024) {
          sess.castBuffer = Buffer.alloc(0);
          break;
        }
        if (sess.castBuffer.length < 4 + msgLen) break;
        const body = sess.castBuffer.subarray(4, 4 + msgLen);
        sess.castBuffer = sess.castBuffer.subarray(4 + msgLen);
        try {
          const pkt = decodeCastV2Message(body);
          handleChromecastPacket(sess, pkt, chosenUrl);
        } catch {
          // ignore malformed packet
        }
      }
    });

    sess.tlsSocket = sock;
  });

  sess.tlsSocket?.setTimeout(0);
  sendCastJson(sess, 'receiver-0', CAST_NS_CONNECTION, { type: 'CONNECT', origin: {} });
  sendCastJson(sess, 'receiver-0', CAST_NS_RECEIVER, {
    type: 'LAUNCH',
    appId: CHROMECAST_DEFAULT_APP_ID,
    requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
  });
  sess.state.status = 'buffering';

  sess.pollTimer = setInterval(() => {
    if (activeSession?.gen !== gen || !sess.tlsSocket || sess.tlsSocket.destroyed) return;
    const now = Date.now();
    if (now - (sess.lastPingMs || 0) >= 4500) {
      sess.lastPingMs = now;
      sendCastJson(sess, 'receiver-0', CAST_NS_HEARTBEAT, { type: 'PING' });
    }
    if (sess.transportId) {
      sendCastJson(sess, sess.transportId, CAST_NS_MEDIA, {
        type: 'GET_STATUS',
        requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
      });
    }
  }, 2000);

  return { ...sess.state };
}

function handleChromecastPacket(
  sess: ActiveServerCastSession,
  pkt: CastV2Packet,
  initialUrl: string
): void {
  if (!pkt.payloadUtf8) return;
  const json = JSON.parse(pkt.payloadUtf8) as Record<string, unknown>;
  const type = String(json.type || '');

  if (pkt.namespace === CAST_NS_HEARTBEAT) {
    if (type === 'PING') {
      sendCastJson(sess, 'receiver-0', CAST_NS_HEARTBEAT, { type: 'PONG' });
    }
    return;
  }

  if (pkt.namespace === CAST_NS_RECEIVER) {
    if (type === 'LAUNCH_ERROR') {
      sess.state.status = 'error';
      sess.state.active = false;
      sess.state.errorMessage = `A TV recusou iniciar o player (${String(json.reason || 'erro')}).`;
      teardownSession(sess, false);
      return;
    }
    if (type === 'RECEIVER_STATUS') {
      const st = json.status as {
        volume?: { level?: number; muted?: boolean };
        applications?: Array<{ appId?: string; transportId?: string; sessionId?: string }>;
      } | null;
      if (!st) return;
      if (typeof st.volume?.level === 'number') {
        sess.state.volume = Math.max(0, Math.min(1, st.volume.level));
      }
      if (typeof st.volume?.muted === 'boolean') {
        sess.state.muted = st.volume.muted;
      }
      const app = st.applications?.find((a) => a.appId === CHROMECAST_DEFAULT_APP_ID);
      if (app?.transportId && app.transportId !== sess.transportId) {
        sess.transportId = app.transportId;
        sess.appSessionId = app.sessionId || '';
        sendCastJson(sess, sess.transportId, CAST_NS_CONNECTION, { type: 'CONNECT', origin: {} });
        if (!sess.mediaLoaded) {
          sess.mediaLoaded = true;
          sendChromecastLoad(sess, initialUrl);
        }
      }
    }
    return;
  }

  if (pkt.namespace === CAST_NS_MEDIA) {
    if (type === 'LOAD_FAILED') {
      if (
        sess.state.deliveryMode === 'direct' &&
        !sess.attemptedDirectFallback &&
        sess.lanStreamUrl
      ) {
        sess.attemptedDirectFallback = true;
        sess.state.deliveryMode = 'background-proxy';
        sendChromecastLoad(sess, sess.lanStreamUrl);
      } else {
        sess.state.status = 'error';
        sess.state.active = false;
        sess.state.errorMessage = 'A TV não conseguiu reproduzir este servidor. Tente outro servidor.';
        teardownSession(sess, false);
      }
      return;
    }
    if (type === 'MEDIA_STATUS') {
      const arr = Array.isArray(json.status) ? json.status : [];
      const ms = arr[0] as
        | {
            mediaSessionId?: number;
            playerState?: string;
            idleReason?: string;
            currentTime?: number;
            media?: { duration?: number };
          }
        | undefined;
      if (!ms) return;
      if (typeof ms.mediaSessionId === 'number') sess.mediaSessionId = ms.mediaSessionId;
      if (typeof ms.currentTime === 'number' && ms.currentTime >= 0) {
        sess.state.positionMs = Math.round(ms.currentTime * 1000);
      }
      if (typeof ms.media?.duration === 'number' && ms.media.duration > 0) {
        sess.state.durationMs = Math.round(ms.media.duration * 1000);
      }
      if (ms.playerState === 'PLAYING') {
        sess.state.status = 'playing';
      } else if (ms.playerState === 'PAUSED') {
        sess.state.status = 'paused';
      } else if (ms.playerState === 'BUFFERING') {
        sess.state.status = 'buffering';
      } else if (ms.playerState === 'IDLE') {
        if (ms.idleReason === 'FINISHED') {
          sess.state.status = 'stopped';
          sess.state.active = false;
          teardownSession(sess, false);
        } else if (ms.idleReason === 'ERROR') {
          if (
            sess.state.deliveryMode === 'direct' &&
            !sess.attemptedDirectFallback &&
            sess.lanStreamUrl
          ) {
            sess.attemptedDirectFallback = true;
            sess.state.deliveryMode = 'background-proxy';
            sendChromecastLoad(sess, sess.lanStreamUrl);
          } else {
            sess.state.status = 'error';
            sess.state.active = false;
            sess.state.errorMessage = 'Erro de reprodução na TV. Tente outro servidor.';
            teardownSession(sess, false);
          }
        }
      }
    }
  }
}

export async function controlServerTvCast(command: {
  action: 'play' | 'pause' | 'toggle' | 'seek' | 'seekBy' | 'volume';
  positionMs?: number;
  deltaMs?: number;
  volume?: number;
}): Promise<TvCastStateSnapshot> {
  const sess = activeSession;
  if (!sess || !sess.state.active) {
    return { ...IDLE_TV_CAST_STATE };
  }

  let effectiveAction = command.action;
  if (effectiveAction === 'toggle') {
    effectiveAction =
      sess.state.status === 'playing' || sess.state.status === 'buffering' ? 'pause' : 'play';
  }

  if (sess.device.protocol === 'chromecast') {
    if (effectiveAction === 'play' && sess.transportId && typeof sess.mediaSessionId === 'number') {
      sendCastJson(sess, sess.transportId, CAST_NS_MEDIA, {
        type: 'PLAY',
        mediaSessionId: sess.mediaSessionId,
        requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
      });
      sess.state.status = 'playing';
    } else if (effectiveAction === 'pause' && sess.transportId && typeof sess.mediaSessionId === 'number') {
      sendCastJson(sess, sess.transportId, CAST_NS_MEDIA, {
        type: 'PAUSE',
        mediaSessionId: sess.mediaSessionId,
        requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
      });
      sess.state.status = 'paused';
    } else if ((effectiveAction === 'seek' || effectiveAction === 'seekBy') && sess.transportId && typeof sess.mediaSessionId === 'number') {
      const target =
        effectiveAction === 'seekBy'
          ? Math.max(0, sess.state.positionMs + (command.deltaMs || 0))
          : Math.max(0, command.positionMs || 0);
      sendCastJson(sess, sess.transportId, CAST_NS_MEDIA, {
        type: 'SEEK',
        mediaSessionId: sess.mediaSessionId,
        currentTime: target / 1000,
        resumeState: 'PLAYBACK_START',
        requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
      });
      sess.state.positionMs = target;
    } else if (effectiveAction === 'volume') {
      const level = Math.max(0, Math.min(1, Number(command.volume ?? 1)));
      sendCastJson(sess, 'receiver-0', CAST_NS_RECEIVER, {
        type: 'SET_VOLUME',
        volume: { level, muted: level <= 0.001 },
        requestId: (sess.reqSeq = (sess.reqSeq || 1) + 1),
      });
      sess.state.volume = level;
      sess.state.muted = level <= 0.001;
    }
  } else if (sess.device.protocol === 'dlna' && sess.device.avTransportControlUrl) {
    if (effectiveAction === 'play') {
      await sendDlnaSoap(sess.device.avTransportControlUrl, UPNP_AV_TRANSPORT_SERVICE, 'Play', {
        InstanceID: '0',
        Speed: '1',
      });
      sess.state.status = 'playing';
    } else if (effectiveAction === 'pause') {
      await sendDlnaSoap(sess.device.avTransportControlUrl, UPNP_AV_TRANSPORT_SERVICE, 'Pause', {
        InstanceID: '0',
      });
      sess.state.status = 'paused';
    } else if (effectiveAction === 'seek' || effectiveAction === 'seekBy') {
      const target =
        effectiveAction === 'seekBy'
          ? Math.max(0, sess.state.positionMs + (command.deltaMs || 0))
          : Math.max(0, command.positionMs || 0);
      await sendDlnaSoap(sess.device.avTransportControlUrl, UPNP_AV_TRANSPORT_SERVICE, 'Seek', {
        InstanceID: '0',
        Unit: 'REL_TIME',
        Target: formatDlnaTime(target),
      });
      sess.state.positionMs = target;
    } else if (effectiveAction === 'volume' && sess.device.renderingControlUrl) {
      const level = Math.max(0, Math.min(1, Number(command.volume ?? 1)));
      await sendDlnaSoap(sess.device.renderingControlUrl, UPNP_RENDERING_CONTROL_SERVICE, 'SetVolume', {
        InstanceID: '0',
        Channel: 'Master',
        DesiredVolume: String(Math.round(level * 100)),
      });
      sess.state.volume = level;
      sess.state.muted = level <= 0.001;
    }
  }

  return { ...sess.state };
}

export function prepareServerLanLink(media: TvCastMediaPayload, serverPort: number): {
  streamUrl: string;
  lanStreamUrl: string;
  directUrl: string;
} {
  const token = crypto.randomBytes(16).toString('hex');
  const lanIp = selectLanIpForDeviceHost();
  const isHls = media.streamFormat === 'hls' || M3U8_EXT_RE.test(media.streamUrl);
  const suffix = isHls ? 'playlist.m3u8' : 'stream.mp4';
  const safeRef = isSafeExternalHttpUrl(media.referer) ? media.referer : 'https://topanimes.net/';
  const lanBaseUrl = lanIp ? `http://${lanIp}:${serverPort}` : '';
  const lanStreamUrl = lanBaseUrl
    ? `${lanBaseUrl}/api/tv-cast/media/${token}/${suffix}?url=${encodeURIComponent(
        media.streamUrl
      )}&referer=${encodeURIComponent(safeRef)}`
    : '';

  if (lanStreamUrl) {
    const prev = activeSession;
    activeSession = {
      gen: ++sessionGenCounter,
      token,
      device: {
        id: 'lan-link',
        name: 'Link Wi-Fi (Smart TV)',
        host: lanIp,
        port: serverPort,
        protocol: 'lan',
      },
      media,
      deliveryPreference: 'proxy',
      attemptedDirectFallback: false,
      lanBaseUrl,
      lanStreamUrl,
      lanSubtitleUrl: media.subtitleUrl ? `${lanBaseUrl}/api/tv-cast/media/${token}/subtitle.vtt` : '',
      state: {
        ...IDLE_TV_CAST_STATE,
        active: true,
        status: 'playing',
        deviceId: 'lan-link',
        deviceName: 'Smart TV (Link Wi-Fi)',
        deviceProtocol: 'lan',
        deliveryMode: 'lan-link',
        episodeUrl: media.episodeUrl || '',
        episodeTitle: media.title || 'Anisync',
        seriesTitle: media.seriesTitle || '',
        seriesUrl: media.seriesUrl || '',
        poster: media.poster || '',
        streamUrl: media.streamUrl,
        lanStreamUrl,
      },
    };
    teardownSession(prev, true);
  }

  return {
    streamUrl: lanStreamUrl || media.streamUrl,
    lanStreamUrl,
    directUrl: media.streamUrl,
  };
}
