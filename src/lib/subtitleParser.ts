export type SubtitleFormat = 'ass' | 'text';

export interface SubtitleCueStyle {
  name: string;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  primaryColor: [number, number, number];
  primaryAlpha: number;
  outlineColor: [number, number, number];
  outlineAlpha: number;
  shadowColor: [number, number, number];
  shadowAlpha: number;
  outline: number;
  shadow: number;
  align: number; // numpad 1..9
  marginL: number;
  marginR: number;
  marginV: number;
  scaleX: number;
  scaleY: number;
  spacing: number;
  angle: number;
  borderStyle: number;
}

export interface SubtitleEvent {
  start: number;
  end: number;
  index: number;
  layer: number;
  styleName: string;
  style: SubtitleCueStyle;
  marginL: number;
  marginR: number;
  marginV: number;
  text: string;
}

export interface ParsedSubtitleScript {
  kind: SubtitleFormat;
  resX: number;
  resY: number;
  wrapStyle: number;
  scaledBorderAndShadow: boolean;
  styles: Map<string, SubtitleCueStyle>;
  defaultStyle: SubtitleCueStyle;
  events: SubtitleEvent[];
  maxEnd: number[];
  baseRgb?: [number, number, number];
}

export interface SubtitleRun {
  text: string;
  breakLine?: boolean;
  hardBreak?: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  color: [number, number, number];
  alpha: number;
  outlineColor: [number, number, number];
  outlineAlpha: number;
  shadowColor: [number, number, number];
  shadowAlpha: number;
  fontName: string;
  fontSize: number;
  outline: number;
  shadow: number;
  scaleX: number;
  scaleY: number;
  spacing: number;
  angle: number;
  blur: number;
}

export interface ParsedEventDisplay {
  align: number;
  pos: [number, number] | null;
  move: { x1: number; y1: number; x2: number; y2: number; t1: number; t2: number } | null;
  fad: [number, number] | null;
  wrapStyle: number;
  runs: SubtitleRun[];
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];
const DEFAULT_YELLOW: [number, number, number] = [255, 255, 0];

const CSS_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  aqua: [0, 255, 255],
  magenta: [255, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
};

export function decodeSubtitleBuffer(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const decode = (enc: string, bytes: Uint8Array, fatal = false) =>
    new TextDecoder(enc, { fatal }).decode(bytes);

  if (u.length >= 3 && u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf) {
    return decode('utf-8', u.subarray(3));
  }
  if (u.length >= 2 && u[0] === 0xff && u[1] === 0xfe) {
    return decode('utf-16le', u.subarray(2));
  }
  if (u.length >= 2 && u[0] === 0xfe && u[1] === 0xff) {
    return decode('utf-16be', u.subarray(2));
  }
  if (u.length >= 8) {
    const sampleLen = Math.min(u.length, 400) & ~1;
    let z0 = 0;
    let z1 = 0;
    for (let i = 0; i < sampleLen; i += 2) {
      if (!u[i]) z0 += 1;
      if (!u[i + 1]) z1 += 1;
    }
    if (z1 > sampleLen / 4 && z0 < sampleLen / 40) return decode('utf-16le', u);
    if (z0 > sampleLen / 4 && z1 < sampleLen / 40) return decode('utf-16be', u);
  }
  try {
    return decode('utf-8', u, true);
  } catch {
    return decode('windows-1252', u);
  }
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = String(hex || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function parseClock(s: string): number {
  let v = 0;
  for (const part of String(s).trim().replace(',', '.').split(':')) {
    v = v * 60 + Number.parseFloat(part);
  }
  return v;
}

function parseAssTime(s: string): number {
  const parts = String(s).trim().split(':');
  if (parts.length < 3) return Number.NaN;
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number.parseFloat(parts[2]);
}

function parseAssColorNum(s: string | undefined): number | null {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const val = /^&?h/i.test(t)
    ? Number.parseInt(t.replace(/^&?h/i, '').replace(/&+$/, ''), 16)
    : Number.parseInt(t, 10);
  return Number.isNaN(val) ? null : val >>> 0;
}

function parseAssStyleColor(
  s: string | undefined,
  fallbackRgb: [number, number, number]
): { rgb: [number, number, number]; alpha: number } {
  const v = parseAssColorNum(s);
  if (v === null) return { rgb: fallbackRgb, alpha: 1 };
  return {
    rgb: [v & 255, (v >> 8) & 255, (v >> 16) & 255],
    alpha: 1 - ((v >>> 24) & 255) / 255,
  };
}

function parseCssColor(raw: string): [number, number, number] | null {
  const v = String(raw || '').trim().toLowerCase();
  const hex6 = hexToRgb(v);
  if (hex6) return hex6;
  const hex3 = v.match(/^#([0-9a-f]{3})$/);
  if (hex3) {
    return [
      Number.parseInt(hex3[1][0] + hex3[1][0], 16),
      Number.parseInt(hex3[1][1] + hex3[1][1], 16),
      Number.parseInt(hex3[1][2] + hex3[1][2], 16),
    ];
  }
  const rgbMatch = v.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    return [
      Number(rgbMatch[1]) & 255,
      Number(rgbMatch[2]) & 255,
      Number(rgbMatch[3]) & 255,
    ];
  }
  return CSS_COLORS[v] || null;
}

function makeDefaultStyle(overrides: Partial<SubtitleCueStyle> = {}): SubtitleCueStyle {
  return {
    name: 'Default',
    font: 'Plus Jakarta Sans',
    size: 20,
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    primaryColor: WHITE,
    primaryAlpha: 1,
    outlineColor: BLACK,
    outlineAlpha: 1,
    shadowColor: BLACK,
    shadowAlpha: 0.8,
    outline: 2,
    shadow: 2,
    align: 2,
    marginL: 10,
    marginR: 10,
    marginV: 10,
    scaleX: 1,
    scaleY: 1,
    spacing: 0,
    angle: 0,
    borderStyle: 1,
    ...overrides,
  };
}

function htmlColorTag(rgb: [number, number, number]): string {
  const h = (n: number) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
  return `{\\c&H${h(rgb[2])}${h(rgb[1])}${h(rgb[0])}&}`;
}

export function cueToAssText(src: string, settings = ''): string {
  let s = String(src)
    .replace(/\\(?=[Nnh])/g, '\\\u200B')
    .replace(/\{([^{}\\]*)\}/g, '\\{$1\\}');

  const colorStack: Array<[number, number, number] | null> = [];
  const lastColor = () => {
    for (let i = colorStack.length - 1; i >= 0; i -= 1) {
      if (colorStack[i]) return colorStack[i];
    }
    return null;
  };

  s = s.replace(
    /<(\/?)([a-z][a-z0-9]*)((?:\.[^\s>.]+)*)(\s[^>]*)?>|<\d{1,2}:\d\d[\d:.]*>/gi,
    (_m, close: string, tag: string, cls: string, attrs: string) => {
      if (!tag) return '';
      const lower = tag.toLowerCase();
      const open = !close;
      switch (lower) {
        case 'i':
        case 'em':
          return open ? '{\\i1}' : '{\\i}';
        case 'b':
        case 'strong':
          return open ? '{\\b1}' : '{\\b}';
        case 'u':
          return open ? '{\\u1}' : '{\\u}';
        case 's':
        case 'strike':
        case 'del':
          return open ? '{\\s1}' : '{\\s}';
        case 'font':
        case 'c': {
          if (!open) {
            if (!colorStack.length) return '';
            colorStack.pop();
            const prev = lastColor();
            return prev ? htmlColorTag(prev) : '{\\c}';
          }
          let col: [number, number, number] | null = null;
          let out = '';
          if (lower === 'font') {
            const cm = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '');
            if (cm) col = parseCssColor(cm[1] || cm[2] || cm[3]);
            const fm = /\bface\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '');
            if (fm && (fm[1] || fm[2] || fm[3])) {
              out += `{\\fn${(fm[1] || fm[2] || fm[3]).replace(/[\\{}]/g, '')}}`;
            }
          } else {
            for (const c of (cls || '').split('.')) {
              if (c && CSS_COLORS[c.toLowerCase()]) col = CSS_COLORS[c.toLowerCase()];
            }
          }
          colorStack.push(col);
          return out + (col ? htmlColorTag(col) : '');
        }
        default:
          return '';
      }
    }
  );

  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1].toLowerCase() === 'x'
        ? Number.parseInt(ent.slice(2), 16)
        : Number.parseInt(ent.slice(1), 10);
      if (!code || code > 0x10ffff) return '';
      const ch = String.fromCodePoint(code);
      return ch === '\\' || ch === '{' || ch === '}' ? '' : ch;
    }
    const mapped = entities[ent.toLowerCase()];
    return mapped !== undefined ? mapped : m;
  });

  s = s.replace(/\n/g, '\\N');

  if (settings) {
    const al = /\balign:(\w+)/.exec(settings);
    const ln = /\bline:(-?[\d.]+)(%?)/.exec(settings);
    let h = 1;
    if (al) {
      h = /^(?:start|left)$/i.test(al[1]) ? 0 : /^(?:end|right)$/i.test(al[1]) ? 2 : 1;
    }
    let top = false;
    if (ln) {
      const v = Number.parseFloat(ln[1]);
      top = ln[2] ? v < 50 : v >= 0 && v < 8;
    }
    const an = (top ? 7 : 1) + h;
    if (an !== 2) s = `{\\an${an}}${s}`;
  }

  return s;
}

const CUE_TIME_RE = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)(.*)$/;

export function parseSrtOrVttCues(
  text: string
): Array<{ start: number; end: number; text: string; settings: string }> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cues: Array<{ start: number; end: number; text: string; settings: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = CUE_TIME_RE.exec(lines[i]);
    if (!match) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (!lines[j].trim() || CUE_TIME_RE.test(lines[j])) break;
      body.push(lines[j]);
    }
    if (
      j < lines.length &&
      CUE_TIME_RE.test(lines[j]) &&
      body.length &&
      /^\d+$/.test(body[body.length - 1].trim())
    ) {
      body.pop();
    }
    const start = parseClock(match[1]);
    const end = parseClock(match[2]);
    if (body.length && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      cues.push({
        start,
        end,
        text: body.join('\n'),
        settings: match[3] || '',
      });
    }
    i = j - 1;
  }

  return cues;
}

function finishParsedScript(script: ParsedSubtitleScript): ParsedSubtitleScript {
  if (!script.resX && !script.resY) {
    script.resX = 384;
    script.resY = 288;
  } else if (!script.resY) {
    script.resY = script.resX === 1280 ? 1024 : Math.round((script.resX * 3) / 4);
  } else if (!script.resX) {
    script.resX = script.resY === 1024 ? 1280 : Math.round((script.resY * 4) / 3);
  }

  const fallback = script.styles.get('default') || script.defaultStyle;
  for (const ev of script.events) {
    ev.style = script.styles.get(ev.styleName) || fallback;
  }

  script.events.sort((a, b) => a.start - b.start || a.index - b.index);
  let mx = Number.NEGATIVE_INFINITY;
  script.maxEnd = script.events.map((ev) => {
    mx = Math.max(mx, ev.end);
    return mx;
  });
  return script;
}

function legacyAlign(a: number): number {
  return a >= 9 ? a - 5 : a >= 5 ? a + 2 : a >= 1 ? a : 2;
}

export function parseAssScript(src: string): ParsedSubtitleScript {
  const defaultStyle = makeDefaultStyle();
  const script: ParsedSubtitleScript = {
    kind: 'ass',
    resX: 0,
    resY: 0,
    wrapStyle: 0,
    scaledBorderAndShadow: false,
    styles: new Map(),
    defaultStyle,
    events: [],
    maxEnd: [],
  };

  let section = '';
  let v4plus = true;
  let sfmt: string[] | null = null;
  let efmt: string[] | null = null;
  let order = 0;

  const lines = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line[0] === ';' || line[0] === '!') continue;
    if (line[0] === '[') {
      const m = /^\[([^\]]*)\]/.exec(line);
      if (m) {
        section = m[1].trim().toLowerCase();
        if (/^v4/.test(section)) v4plus = section.includes('+');
        continue;
      }
    }

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).replace(/^\s+/, '');

    if (section === 'script info') {
      const lv = val.trim().toLowerCase();
      if (key === 'playresx') script.resX = Number.parseInt(val, 10) || 0;
      else if (key === 'playresy') script.resY = Number.parseInt(val, 10) || 0;
      else if (key === 'wrapstyle') script.wrapStyle = Number.parseInt(val, 10) || 0;
      else if (key === 'scaledborderandshadow') {
        script.scaledBorderAndShadow = lv === 'yes' || lv === 'true' || lv === '1';
      }
    } else if (/^v4/.test(section)) {
      if (key === 'format') {
        sfmt = val.split(',').map((s) => s.trim().toLowerCase());
      } else if (key === 'style') {
        const fmt = sfmt || [
          'name',
          'fontname',
          'fontsize',
          'primarycolour',
          'secondarycolour',
          'outlinecolour',
          'backcolour',
          'bold',
          'italic',
          'underline',
          'strikeout',
          'scalex',
          'scaley',
          'spacing',
          'angle',
          'borderstyle',
          'outline',
          'shadow',
          'alignment',
          'marginl',
          'marginr',
          'marginv',
          'encoding',
        ];
        const parts = val.split(',');
        const fields: Record<string, string | undefined> = {};
        fmt.forEach((k, idx) => {
          fields[k] = parts[idx];
        });
        const num = (k: string, d: number) => {
          const parsed = Number.parseFloat(fields[k] || '');
          return Number.isNaN(parsed) ? d : parsed;
        };
        const rawAlign = Math.round(num('alignment', 2));
        const align = v4plus
          ? rawAlign >= 1 && rawAlign <= 9
            ? rawAlign
            : 2
          : legacyAlign(rawAlign);
        const c1 = parseAssStyleColor(fields.primarycolour, WHITE);
        const c3 = parseAssStyleColor(fields.outlinecolour ?? fields.tertiarycolour, BLACK);
        const c4 = parseAssStyleColor(fields.backcolour, BLACK);
        const st = makeDefaultStyle({
          name: String(fields.name || 'Default').trim(),
          font: String(fields.fontname || 'Arial').trim().replace(/^@/, '') || 'Arial',
          size: num('fontsize', 20),
          primaryColor: c1.rgb,
          primaryAlpha: c1.alpha,
          outlineColor: c3.rgb,
          outlineAlpha: c3.alpha,
          shadowColor: c4.rgb,
          shadowAlpha: c4.alpha,
          bold: Boolean(Number.parseInt(fields.bold || '0', 10)),
          italic: Boolean(Number.parseInt(fields.italic || '0', 10)),
          underline: Boolean(Number.parseInt(fields.underline || '0', 10)),
          strikeout: Boolean(Number.parseInt(fields.strikeout || '0', 10)),
          scaleX: Math.max(0, num('scalex', 100)) / 100,
          scaleY: Math.max(0, num('scaley', 100)) / 100,
          spacing: num('spacing', 0),
          angle: num('angle', 0),
          borderStyle: num('borderstyle', 1),
          outline: Math.max(0, num('outline', 2)),
          shadow: num('shadow', 2),
          align,
          marginL: num('marginl', 10),
          marginR: num('marginr', 10),
          marginV: num('marginv', 10),
        });
        script.styles.set(st.name.toLowerCase(), st);
        if (script.styles.size === 1) script.defaultStyle = st;
      }
    } else if (section === 'events') {
      if (key === 'format') {
        efmt = val.split(',').map((s) => s.trim().toLowerCase());
      } else if (key === 'dialogue') {
        const fmt = efmt || [
          'layer',
          'start',
          'end',
          'style',
          'name',
          'marginl',
          'marginr',
          'marginv',
          'effect',
          'text',
        ];
        const parts: string[] = [];
        let rest = val;
        for (let k = 0; k < fmt.length - 1; k += 1) {
          const idx = rest.indexOf(',');
          if (idx < 0) break;
          parts.push(rest.slice(0, idx));
          rest = rest.slice(idx + 1);
        }
        parts.push(rest);
        const f: Record<string, string | undefined> = {};
        fmt.forEach((k, idx) => {
          f[k] = parts[idx];
        });
        const start = parseAssTime(f.start || '');
        const end = parseAssTime(f.end || '');
        if (!(end > start) || f.text == null) continue;
        script.events.push({
          start,
          end,
          index: order++,
          layer: Number.parseInt(f.layer ?? f.marked ?? '0', 10) || 0,
          styleName: String(f.style || 'Default').trim().replace(/^\*/, '').toLowerCase(),
          style: defaultStyle,
          marginL: Number.parseInt(f.marginl || '0', 10) || 0,
          marginR: Number.parseInt(f.marginr || '0', 10) || 0,
          marginV: Number.parseInt(f.marginv || '0', 10) || 0,
          text: f.text,
        });
      }
    }
  }

  return finishParsedScript(script);
}

export function parseSubtitleContent(
  text: string,
  color: [number, number, number] = DEFAULT_YELLOW
): ParsedSubtitleScript | null {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  if (
    /^\s*\[(?:script info|v4\+? styles|events)\]/im.test(clean) ||
    (/^\s*Dialogue:/m.test(clean) && /\[Events\]/i.test(clean))
  ) {
    const ass = parseAssScript(clean);
    return ass.events.length ? ass : null;
  }

  const cues = parseSrtOrVttCues(clean);
  if (!cues.length) return null;
  cues.sort((a, b) => a.start - b.start);

  const st = makeDefaultStyle({
    name: 'Default',
    font: 'Plus Jakarta Sans',
    size: 56,
    bold: true,
    primaryColor: color,
    primaryAlpha: 1,
    outline: 3.4,
    shadow: 0,
    align: 2,
    marginL: 96,
    marginR: 96,
    marginV: 64,
  });

  const script: ParsedSubtitleScript = {
    kind: 'text',
    resX: 1920,
    resY: 1080,
    wrapStyle: 0,
    scaledBorderAndShadow: true,
    styles: new Map([['default', st]]),
    defaultStyle: st,
    events: cues.map((c, idx) => ({
      start: c.start,
      end: c.end,
      index: idx,
      layer: 0,
      styleName: 'default',
      style: st,
      marginL: 0,
      marginR: 0,
      marginV: 0,
      text: cueToAssText(c.text, c.settings),
    })),
    maxEnd: [],
    baseRgb: color,
  };

  return finishParsedScript(script);
}

export function collectActiveSubtitleEvents(
  script: ParsedSubtitleScript,
  t: number
): SubtitleEvent[] {
  const events = script.events;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const active: SubtitleEvent[] = [];
  for (let i = lo - 1; i >= 0; i -= 1) {
    if (script.maxEnd[i] <= t) break;
    if (events[i].end > t) active.push(events[i]);
  }
  return active.sort((a, b) => a.layer - b.layer || a.index - b.index);
}

export function parseAssEventRuns(
  script: ParsedSubtitleScript,
  ev: SubtitleEvent
): ParsedEventDisplay {
  const base = ev.style;
  let state = {
    bold: base.bold,
    italic: base.italic,
    underline: base.underline,
    strikeout: base.strikeout,
    color: base.primaryColor,
    alpha: base.primaryAlpha,
    outlineColor: base.outlineColor,
    outlineAlpha: base.outlineAlpha,
    shadowColor: base.shadowColor,
    shadowAlpha: base.shadowAlpha,
    fontName: base.font,
    fontSize: base.size,
    outline: base.outline,
    shadow: base.shadow,
    scaleX: base.scaleX,
    scaleY: base.scaleY,
    spacing: base.spacing,
    angle: base.angle,
    blur: 0,
  };

  const display: ParsedEventDisplay = {
    align: 0,
    pos: null,
    move: null,
    fad: null,
    wrapStyle: script.wrapStyle,
    runs: [],
  };

  const tagNames = [
    'fscx', 'fscy', 'xbord', 'ybord', 'xshad', 'yshad', 'alpha', 'blur', 'bord',
    'shad', 'move', 'fad', 'fsp', 'frz', 'pos', '1c', '3c', '4c', '1a', '3a',
    '4a', 'fn', 'fs', 'fr', 'an', 'a', 'b', 'c', 'i', 'q', 'r', 's', 'u',
  ].sort((a, b) => b.length - a.length);

  const applyTagBlock = (block: string) => {
    let i = 0;
    while (i < block.length) {
      const j = block.indexOf('\\', i);
      if (j < 0) break;
      i = j + 1;
      const name = tagNames.find((tn) => block.startsWith(tn, i));
      if (!name) continue;
      i += name.length;
      let arg = '';
      if (block[i] === '(') {
        let depth = 1;
        let k = i + 1;
        while (k < block.length && depth > 0) {
          if (block[k] === '(') depth += 1;
          else if (block[k] === ')') depth -= 1;
          k += 1;
        }
        arg = block.slice(i + 1, depth === 0 ? k - 1 : block.length);
        i = k;
      } else {
        let k = block.indexOf('\\', i);
        if (k < 0) k = block.length;
        arg = block.slice(i, k);
        i = k;
      }
      arg = arg.trim();
      const num = Number.parseFloat(arg);
      const hasNum = arg !== '' && Number.isFinite(num);

      switch (name) {
        case 'an':
          if (!display.align && hasNum && num >= 1 && num <= 9) display.align = Math.round(num);
          break;
        case 'a':
          if (!display.align && hasNum) display.align = legacyAlign(Math.round(num));
          break;
        case 'pos': {
          const coords = arg.split(',').map((x) => Number.parseFloat(x));
          if (coords.length >= 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
            display.pos = [coords[0], coords[1]];
          }
          break;
        }
        case 'move': {
          const vals = arg.split(',').map((x) => Number.parseFloat(x));
          if (vals.length >= 4 && vals.slice(0, 4).every(Number.isFinite)) {
            display.move = {
              x1: vals[0],
              y1: vals[1],
              x2: vals[2],
              y2: vals[3],
              t1: vals.length >= 6 && Number.isFinite(vals[4]) ? vals[4] : 0,
              t2: vals.length >= 6 && Number.isFinite(vals[5]) ? vals[5] : (ev.end - ev.start) * 1000,
            };
          }
          break;
        }
        case 'fad': {
          const vals = arg.split(',').map((x) => Number.parseFloat(x));
          if (vals.length >= 2 && Number.isFinite(vals[0]) && Number.isFinite(vals[1])) {
            display.fad = [Math.max(0, vals[0]), Math.max(0, vals[1])];
          }
          break;
        }
        case 'q':
          if (hasNum && num >= 0 && num <= 3) display.wrapStyle = Math.round(num);
          break;
        case 'b':
          state = { ...state, bold: arg === '' ? base.bold : hasNum ? Boolean(num) : state.bold };
          break;
        case 'i':
          state = { ...state, italic: arg === '' ? base.italic : hasNum ? Boolean(num) : state.italic };
          break;
        case 'u':
          state = { ...state, underline: arg === '' ? base.underline : hasNum ? Boolean(num) : state.underline };
          break;
        case 's':
          state = { ...state, strikeout: arg === '' ? base.strikeout : hasNum ? Boolean(num) : state.strikeout };
          break;
        case 'fn':
          state = { ...state, fontName: arg ? arg.replace(/^@/, '') : base.font };
          break;
        case 'fs':
          state = { ...state, fontSize: hasNum && num > 0 ? num : base.size };
          break;
        case 'fscx':
          state = { ...state, scaleX: hasNum ? Math.max(0, num) / 100 : base.scaleX };
          break;
        case 'fscy':
          state = { ...state, scaleY: hasNum ? Math.max(0, num) / 100 : base.scaleY };
          break;
        case 'fsp':
          state = { ...state, spacing: hasNum ? num : base.spacing };
          break;
        case 'fr':
        case 'frz':
          state = { ...state, angle: hasNum ? num : base.angle };
          break;
        case 'bord':
        case 'xbord':
        case 'ybord':
          state = { ...state, outline: hasNum ? Math.max(0, num) : base.outline };
          break;
        case 'shad':
        case 'xshad':
        case 'yshad':
          state = { ...state, shadow: hasNum ? num : base.shadow };
          break;
        case 'blur':
          state = { ...state, blur: hasNum ? Math.max(0, num) : 0 };
          break;
        case 'c':
        case '1c': {
          const parsed = arg === '' ? null : parseAssStyleColor(arg, base.primaryColor);
          state = { ...state, color: parsed ? parsed.rgb : base.primaryColor };
          break;
        }
        case '3c': {
          const parsed = arg === '' ? null : parseAssStyleColor(arg, base.outlineColor);
          state = { ...state, outlineColor: parsed ? parsed.rgb : base.outlineColor };
          break;
        }
        case '4c': {
          const parsed = arg === '' ? null : parseAssStyleColor(arg, base.shadowColor);
          state = { ...state, shadowColor: parsed ? parsed.rgb : base.shadowColor };
          break;
        }
        case 'alpha':
        case '1a': {
          const v = parseAssColorNum(arg);
          state = { ...state, alpha: v === null ? base.primaryAlpha : 1 - (v & 255) / 255 };
          break;
        }
        case 'r': {
          const target = arg ? script.styles.get(arg.toLowerCase()) || base : base;
          state = {
            bold: target.bold,
            italic: target.italic,
            underline: target.underline,
            strikeout: target.strikeout,
            color: target.primaryColor,
            alpha: target.primaryAlpha,
            outlineColor: target.outlineColor,
            outlineAlpha: target.outlineAlpha,
            shadowColor: target.shadowColor,
            shadowAlpha: target.shadowAlpha,
            fontName: target.font,
            fontSize: target.size,
            outline: target.outline,
            shadow: target.shadow,
            scaleX: target.scaleX,
            scaleY: target.scaleY,
            spacing: target.spacing,
            angle: target.angle,
            blur: 0,
          };
          break;
        }
        default:
          break;
      }
    }
  };

  const pushTextSegment = (segment: string) => {
    if (!segment) return;
    const clean = segment
      .replace(/\\\u200B/g, '\\')
      .replace(/\\\{/g, '{')
      .replace(/\\\}/g, '}')
      .replace(/\\h/g, '\u00A0');

    const parts = clean.split(/(\\[Nn])/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\\N' || part === '\\n') {
        display.runs.push({
          ...state,
          text: '',
          breakLine: true,
          hardBreak: part === '\\N',
        });
      } else {
        display.runs.push({ ...state, text: part });
      }
    }
  };

  const raw = ev.text;
  let pos = 0;
  while (pos < raw.length) {
    const open = raw.indexOf('{', pos);
    if (open < 0) {
      pushTextSegment(raw.slice(pos));
      break;
    }
    if (open > 0 && raw[open - 1] === '\\') {
      pushTextSegment(raw.slice(pos, open + 1));
      pos = open + 1;
      continue;
    }
    if (open > pos) pushTextSegment(raw.slice(pos, open));
    const close = raw.indexOf('}', open + 1);
    if (close < 0) {
      pushTextSegment(raw.slice(open));
      break;
    }
    applyTagBlock(raw.slice(open + 1, close));
    pos = close + 1;
  }

  return display;
}
