import {
  collectActiveSubtitleEvents,
  parseAssEventRuns,
  type ParsedSubtitleScript,
  type SubtitleRun,
} from './subtitleParser';

export interface VideoViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SubtitleRenderOptions {
  delay: number;
  scale: number;
  colorRgb: [number, number, number];
}

const rgba = (rgb: [number, number, number], alpha: number) =>
  `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, alpha))})`;

export function computeContainedVideoRect(
  stageW: number,
  stageH: number,
  videoW: number,
  videoH: number
): VideoViewportRect {
  if (!videoW || !videoH || !stageW || !stageH) {
    return { x: 0, y: 0, w: stageW, h: stageH };
  }
  const stageAspect = stageW / stageH;
  const videoAspect = videoW / videoH;
  if (stageAspect > videoAspect) {
    const h = stageH;
    const w = h * videoAspect;
    return { x: (stageW - w) / 2, y: 0, w, h };
  }
  const w = stageW;
  const h = w / videoAspect;
  return { x: 0, y: (stageH - h) / 2, w, h };
}

export class SubtitleCanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private widthCache = new Map<string, number>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  clear(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private fontStr(run: SubtitleRun, factor: number): string {
    const px = Math.max(1, run.fontSize * factor);
    const weight = run.bold ? 'bold ' : '';
    const style = run.italic ? 'italic ' : '';
    const family = String(run.fontName || 'Plus Jakarta Sans').replace(/['"]/g, '');
    return `${style}${weight}${px.toFixed(2)}px "${family}", "Plus Jakarta Sans", Arial, sans-serif`;
  }

  private measureRun(run: SubtitleRun, factor: number): number {
    if (!run.text || !this.ctx) return 0;
    const f = this.fontStr(run, factor);
    const key = `${f}\0${run.scaleX}\0${run.spacing}\0${run.text}`;
    const cached = this.widthCache.get(key);
    if (cached !== undefined) return cached;
    this.ctx.font = f;
    let w = this.ctx.measureText(run.text).width * run.scaleX;
    if (run.spacing && run.text.length > 1) {
      w += run.spacing * factor * (run.text.length - 1);
    }
    if (this.widthCache.size > 4000) this.widthCache.clear();
    this.widthCache.set(key, w);
    return w;
  }

  private wrapRuns(
    runs: SubtitleRun[],
    maxW: number,
    wrapStyle: number,
    factor: number
  ): SubtitleRun[][] {
    const paras: SubtitleRun[][] = [[]];
    for (const run of runs) {
      if (run.breakLine) {
        if (run.hardBreak || wrapStyle === 2) {
          paras.push([]);
        } else {
          const cur = paras[paras.length - 1];
          if (cur.length && !/\s$/.test(cur[cur.length - 1].text)) {
            cur.push({ ...run, text: ' ', breakLine: false });
          }
        }
      } else {
        paras[paras.length - 1].push(run);
      }
    }

    const trimLine = (line: SubtitleRun[]) => {
      if (!line.length) return line;
      const out = line.map((r) => ({ ...r }));
      out[0].text = out[0].text.replace(/^\s+/, '');
      out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
      return out.filter((r) => r.text);
    };

    const splitWords = (para: SubtitleRun[]) => {
      const toks: SubtitleRun[] = [];
      for (const run of para) {
        for (const piece of run.text.split(/(\s+)/)) {
          if (piece) toks.push({ ...run, text: piece });
        }
      }
      return toks;
    };

    const greedy = (toks: SubtitleRun[], limit: number) => {
      const lines: SubtitleRun[][] = [];
      let line: SubtitleRun[] = [];
      let w = 0;
      for (const tok of toks) {
        if (!line.length && /^\s+$/.test(tok.text)) continue;
        const tw = this.measureRun(tok, factor);
        if (line.length && w + tw > limit) {
          lines.push(trimLine(line));
          line = /^\s+$/.test(tok.text) ? [] : [tok];
          w = line.length ? tw : 0;
        } else {
          line.push(tok);
          w += tw;
        }
      }
      if (line.length) lines.push(trimLine(line));
      return lines;
    };

    const lines: SubtitleRun[][] = [];
    for (const para of paras) {
      const toks = splitWords(para);
      if (!toks.length) {
        lines.push([]);
        continue;
      }
      if (wrapStyle === 2 || !(maxW > 0)) {
        lines.push(trimLine(toks));
        continue;
      }
      const g = greedy(toks, maxW);
      if (g.length > 1 && (wrapStyle === 0 || wrapStyle === 3)) {
        const total = toks.reduce((s, r) => s + this.measureRun(r, factor), 0);
        const minW = total / g.length;
        let lo = minW;
        let hi = maxW;
        let best = g;
        for (let k = 0; k < 10; k += 1) {
          const mid = (lo + hi) / 2;
          const trial = greedy(toks, mid);
          if (trial.length <= g.length) {
            best = trial;
            hi = mid;
          } else {
            lo = mid;
          }
        }
        lines.push(...best);
      } else {
        lines.push(...g);
      }
    }

    return lines;
  }

  render(
    script: ParsedSubtitleScript | null,
    currentTime: number,
    stageW: number,
    stageH: number,
    videoW: number,
    videoH: number,
    dpr: number,
    options: SubtitleRenderOptions
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const cw = Math.max(1, Math.round(stageW * dpr));
    const ch = Math.max(1, Math.round(stageH * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stageW, stageH);

    if (!script) return;
    const t = currentTime - options.delay;
    if (!Number.isFinite(t)) return;

    const active = collectActiveSubtitleEvents(script, t);
    if (!active.length) return;

    const vr = computeContainedVideoRect(stageW, stageH, videoW, videoH);
    const rx = vr.w / script.resX;
    const ry = vr.h / script.resY;
    const scale = options.scale;
    const isTextScript = script.kind === 'text';
    const fontScale = Math.min(rx, ry) * scale;
    const bordScale = script.scaledBorderAndShadow ? fontScale : 1;

    ctx.save();
    ctx.beginPath();
    ctx.rect(vr.x, vr.y, vr.w, vr.h);
    ctx.clip();

    const placed: Array<{ l: number; r: number; t: number; b: number }> = [];

    for (const ev of active) {
      const parsed = parseAssEventRuns(script, ev);
      const st = ev.style;
      const align = parsed.align || st.align || 2;
      const hAlign = (align - 1) % 3;
      const vAlign = align >= 7 ? 0 : align >= 4 ? 1 : 2;
      const ml = (ev.marginL || st.marginL) * rx;
      const mr = (ev.marginR || st.marginR) * rx;
      const mv = (ev.marginV || st.marginV) * ry;

      let fade = 1;
      if (parsed.fad) {
        const dt = (t - ev.start) * 1000;
        const left = (ev.end - t) * 1000;
        if (parsed.fad[0] > 0) fade = Math.min(fade, dt / parsed.fad[0]);
        if (parsed.fad[1] > 0) fade = Math.min(fade, left / parsed.fad[1]);
        fade = Math.max(0, Math.min(1, fade));
      }

      const maxW = parsed.pos || parsed.move ? 0 : Math.max(40, vr.w - ml - mr);
      const lines = this.wrapRuns(parsed.runs, maxW, parsed.wrapStyle, fontScale);
      if (!lines.length) continue;

      const lineMetrics = lines.map((line) => {
        let width = 0;
        let maxSize = st.size * fontScale;
        for (const r of line) {
          width += this.measureRun(r, fontScale);
          maxSize = Math.max(maxSize, r.fontSize * fontScale * r.scaleY);
        }
        return { line, width, lineHeight: maxSize * 1.18, ascent: maxSize * 0.84 };
      });

      const blockW = lineMetrics.reduce((m, l) => Math.max(m, l.width), 0);
      const blockH = lineMetrics.reduce((s, l) => s + l.lineHeight, 0);

      let ax: number;
      let ay: number;
      if (parsed.move) {
        const m = parsed.move;
        const dt = (t - ev.start) * 1000;
        const frac = m.t2 > m.t1 ? Math.max(0, Math.min(1, (dt - m.t1) / (m.t2 - m.t1))) : dt >= m.t1 ? 1 : 0;
        ax = vr.x + (m.x1 + (m.x2 - m.x1) * frac) * rx;
        ay = vr.y + (m.y1 + (m.y2 - m.y1) * frac) * ry;
      } else if (parsed.pos) {
        ax = vr.x + parsed.pos[0] * rx;
        ay = vr.y + parsed.pos[1] * ry;
      } else {
        ax =
          hAlign === 0
            ? vr.x + ml
            : hAlign === 2
              ? vr.x + vr.w - mr
              : vr.x + (vr.w + ml - mr) / 2;
        ay =
          vAlign === 0
            ? vr.y + mv
            : vAlign === 1
              ? vr.y + vr.h / 2
              : vr.y + vr.h - mv;
      }

      let bx = hAlign === 0 ? ax : hAlign === 2 ? ax - blockW : ax - blockW / 2;
      let by = vAlign === 0 ? ay : vAlign === 1 ? ay - blockH / 2 : ay - blockH;

      if (!parsed.pos && !parsed.move) {
        const box = { l: bx, r: bx + blockW, t: by, b: by + blockH };
        const dir = vAlign === 0 ? 1 : -1;
        for (let guard = 0; guard < 12; guard += 1) {
          const hit = placed.find(
            (p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t
          );
          if (!hit) break;
          const shift = dir < 0 ? hit.t - box.b - 2 : hit.b - box.t + 2;
          box.t += shift;
          box.b += shift;
          by += shift;
        }
        placed.push(box);
      }

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.textBaseline = 'alphabetic';

      let curY = by;
      for (const lm of lineMetrics) {
        let curX =
          hAlign === 0
            ? bx
            : hAlign === 2
              ? bx + blockW - lm.width
              : bx + (blockW - lm.width) / 2;
        const baselineY = curY + lm.ascent;

        for (const run of lm.line) {
          const rw = this.measureRun(run, fontScale);
          if (!run.text) continue;

          const activeColor: [number, number, number] = isTextScript
            ? options.colorRgb
            : run.color;

          ctx.save();
          ctx.font = this.fontStr(run, fontScale);
          ctx.translate(curX, baselineY);
          if (run.angle) ctx.rotate((-run.angle * Math.PI) / 180);
          if (run.scaleX !== 1 || run.scaleY !== 1) ctx.scale(run.scaleX, run.scaleY);

          const outlineW = run.outline * bordScale * 2;
          const shadDist = run.shadow * bordScale;

          if (run.blur > 0) {
            ctx.shadowBlur = run.blur * fontScale;
          }

          if (shadDist > 0) {
            ctx.save();
            ctx.translate(shadDist / Math.max(0.01, run.scaleX), shadDist / Math.max(0.01, run.scaleY));
            ctx.fillStyle = rgba(run.shadowColor, run.shadowAlpha * run.alpha);
            ctx.fillText(run.text, 0, 0);
            ctx.restore();
          }

          if (outlineW > 0) {
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.lineWidth = outlineW;
            ctx.strokeStyle = rgba(run.outlineColor, run.outlineAlpha * run.alpha);
            ctx.strokeText(run.text, 0, 0);
          }

          ctx.fillStyle = rgba(activeColor, run.alpha);
          ctx.fillText(run.text, 0, 0);
          ctx.restore();

          curX += rw;
        }
        curY += lm.lineHeight;
      }

      ctx.restore();
    }

    ctx.restore();
  }
}
