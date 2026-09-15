/**
 * Procedural "media" generators, one per ArtStyle. Each draws into a
 * (w × h) context using only the supplied seeded RNG, so output is stable.
 */
import type { ArtStyle } from "./item";
import { chance, int, pick, range, type Rng } from "./random";
import { clamp01, makeNoise, smoothstep } from "./noise";

type Ctx = CanvasRenderingContext2D;

const PAPERS = ["#efece5", "#f4f2ee", "#e9e7e0", "#fbfaf7", "#e5e3dc"];
const DARKS = ["#0a0a0a", "#0e0e10", "#121214", "#151517", "#0d0f12"];
const INK = "#161616";

export const SANS = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
export const MONO = 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';
export const SERIF = 'Georgia, "Times New Roman", serif';

const WORDS = [
  "Settings", "Untitled", "Archive", "Index", "Inbox", "Library", "Export", "Layers", "Preview",
  "Network", "Console", "Terminal", "Objects", "Search", "Notes", "Window", "Dialog", "Preferences",
  "Catalog", "Field notes", "Appendix", "Chapter 3", "Specimen", "Glyphs", "Overview", "Properties",
];

const hsl = (h: number, s: number, l: number, a = 1) =>
  `hsla(${((h % 360) + 360) % 360}, ${clamp(s, 0, 100)}%, ${clamp(l, 0, 100)}%, ${a})`;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function grain(ctx: Ctx, w: number, h: number, rng: Rng, amount: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function vignette(ctx: Ctx, w: number, h: number, strength: number) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

/** Greeked text: rows of bars with ragged right edges. */
function bars(
  ctx: Ctx,
  rng: Rng,
  x: number,
  y: number,
  width: number,
  count: number,
  color: string,
  lineH = 2,
  gap = 3,
  paragraphs = true,
) {
  ctx.fillStyle = color;
  let yy = y;
  for (let i = 0; i < count; i++) {
    const last = paragraphs && chance(rng, 0.22);
    const bw = width * (last ? range(rng, 0.25, 0.7) : range(rng, 0.82, 1));
    ctx.fillRect(x, yy, bw, lineH);
    yy += lineH + gap + (last ? gap * 1.5 : 0);
  }
  return yy;
}

function label(ctx: Ctx, text: string, x: number, y: number, size: number, color: string, font = SANS, weight = "500") {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}

/* ------------------------------------------------------------------ photo */

function photo(ctx: Ctx, w: number, h: number, rng: Rng) {
  const hue = range(rng, 0, 360);
  const sat = range(rng, 4, 26);
  const light = range(rng, 16, 58);
  const motif = pick(rng, ["blobs", "blocks", "object", "horizon", "blobs", "object"] as const);
  const m = Math.max(w, h);
  ctx.fillStyle = hsl(hue, sat, light);
  ctx.fillRect(0, 0, w, h);

  const blobs = (count: number, spread: number) => {
    for (let i = 0; i < count; i++) {
      const x = range(rng, -0.2, 1.2) * w;
      const y = range(rng, -0.2, 1.2) * h;
      const r = range(rng, 0.25, 0.8) * m * spread;
      const bh = hue + range(rng, -35, 35);
      const bs = sat + range(rng, -6, 18);
      const bl = light + range(rng, -28, 28);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hsl(bh, bs, bl, 0.95));
      g.addColorStop(1, hsl(bh, bs, bl, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  };

  switch (motif) {
    case "blobs":
      blobs(int(rng, 5, 10), 1);
      break;
    case "horizon": {
      blobs(3, 1.2);
      const hy = range(rng, 0.45, 0.72) * h;
      const g = ctx.createLinearGradient(0, hy, 0, h);
      g.addColorStop(0, hsl(hue, sat, light * 0.55));
      g.addColorStop(1, hsl(hue, sat, light * 0.22));
      ctx.fillStyle = g;
      ctx.fillRect(0, hy, w, h - hy);
      ctx.fillStyle = hsl(hue, sat, light + 30, 0.35);
      ctx.fillRect(0, hy - 1, w, 2);
      break;
    }
    case "blocks": {
      blobs(2, 1.2);
      let x = -range(rng, 0, 0.1) * w;
      while (x < w) {
        const bw = range(rng, 0.08, 0.3) * w;
        const bh = range(rng, 0.3, 0.95) * h;
        const shade = light + range(rng, -22, 10);
        ctx.fillStyle = hsl(hue + range(rng, -8, 8), sat, shade);
        ctx.fillRect(x, h - bh, bw, bh);
        if (chance(rng, 0.65)) {
          ctx.fillStyle = hsl(hue, sat, shade + (chance(rng, 0.5) ? 20 : -12), 0.8);
          const cw = range(rng, 3, 7);
          const ch = range(rng, 3, 9);
          const gap = range(rng, 2, 6);
          for (let yy = h - bh + gap; yy < h - ch; yy += ch + gap)
            for (let xx = x + gap; xx < x + bw - cw; xx += cw + gap) if (chance(rng, 0.7)) ctx.fillRect(xx, yy, cw, ch);
        }
        x += bw + range(rng, 0, 0.04) * w;
      }
      break;
    }
    case "object": {
      blobs(2, 1.4);
      const ow = range(rng, 0.42, 0.78) * w;
      const oh = range(rng, 0.22, 0.58) * h;
      const ox = (w - ow) / 2 + range(rng, -0.05, 0.05) * w;
      const oy = (h - oh) / 2 + range(rng, -0.05, 0.1) * h;
      const radius = range(rng, 3, 14);
      for (let i = 6; i >= 1; i--) {
        ctx.fillStyle = `rgba(0,0,0,${0.06})`;
        rrect(ctx, ox - i * 1.5 + 4, oy - i * 1.5 + 10, ow + i * 3, oh + i * 3, radius + i);
        ctx.fill();
      }
      const tone = light + (chance(rng, 0.5) ? 30 : -14);
      const g = ctx.createLinearGradient(ox, oy, ox + ow, oy + oh);
      g.addColorStop(0, hsl(hue, sat * 0.6, tone + 10));
      g.addColorStop(1, hsl(hue, sat * 0.6, tone - 12));
      ctx.fillStyle = g;
      rrect(ctx, ox, oy, ow, oh, radius);
      ctx.fill();
      if (chance(rng, 0.5)) {
        // keyboard-ish key grid
        const gap = range(rng, 2, 4);
        const kw = range(rng, 8, 16);
        const kh = kw * range(rng, 0.8, 1.1);
        const inset = range(rng, 6, 12);
        for (let yy = oy + inset; yy + kh < oy + oh - inset; yy += kh + gap)
          for (let xx = ox + inset + (chance(rng, 0.3) ? kw * 0.4 : 0); xx + kw < ox + ow - inset; xx += kw + gap) {
            ctx.fillStyle = hsl(hue, sat * 0.5, tone + (chance(rng, 0.15) ? -20 : -6));
            rrect(ctx, xx, yy, kw, kh, 2);
            ctx.fill();
          }
      } else {
        const inset = range(rng, 5, 10);
        const sg = ctx.createLinearGradient(ox, oy, ox + ow * 0.6, oy + oh);
        sg.addColorStop(0, hsl(hue + 10, sat, tone - 35));
        sg.addColorStop(1, hsl(hue - 10, sat, tone - 48));
        ctx.fillStyle = sg;
        rrect(ctx, ox + inset, oy + inset, ow - inset * 2, oh - inset * 2, 3);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.moveTo(ox + inset, oy + inset);
        ctx.lineTo(ox + ow - inset, oy + inset);
        ctx.lineTo(ox + inset, oy + oh * 0.5);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
  }
  vignette(ctx, w, h, range(rng, 0.2, 0.5));
  grain(ctx, w, h, rng, range(rng, 6, 20));
}

/* --------------------------------------------------------------------- ui */

interface UiTheme {
  desk: string;
  win: string;
  bar: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
}

function ui(ctx: Ctx, w: number, h: number, rng: Rng) {
  const variant = pick(rng, ["light", "light", "dark", "retro", "light"] as const);
  const t: UiTheme =
    variant === "light"
      ? { desk: pick(rng, ["#d9d9d9", "#e4e4e4", "#cfcfd3"]), win: "#f6f6f6", bar: "#ebebeb", line: "#c6c6c6", text: "#3a3a3a", muted: "#b9b9b9", accent: "#2f6fed", border: "#bcbcbc" }
      : variant === "dark"
        ? { desk: "#0b0b0b", win: "#181818", bar: "#202020", line: "#343434", text: "#d0d0d0", muted: "#4c4c4c", accent: "#5b8cff", border: "#2e2e2e" }
        : { desk: pick(rng, ["#008080", "#3a6ea5", "#7b7b7b", "#5f9ea0"]), win: "#c0c0c0", bar: "#000080", line: "#808080", text: "#111111", muted: "#8a8a8a", accent: "#000080", border: "#404040" };

  ctx.fillStyle = t.desk;
  ctx.fillRect(0, 0, w, h);

  const pad = variant === "retro" ? range(rng, 0.05, 0.14) : chance(rng, 0.5) ? 0 : range(rng, 0.03, 0.1);
  const wx = Math.round(pad * w);
  const wy = Math.round(pad * h);
  const ww = w - wx * 2;
  const wh = h - wy * 2;
  const barH = variant === "retro" ? 11 : 13;

  // window chrome
  ctx.fillStyle = t.win;
  ctx.fillRect(wx, wy, ww, wh);
  if (variant === "retro") {
    bevel(ctx, wx, wy, ww, wh);
    const g = ctx.createLinearGradient(wx, 0, wx + ww, 0);
    g.addColorStop(0, "#000080");
    g.addColorStop(1, "#1084d0");
    ctx.fillStyle = g;
    ctx.fillRect(wx + 3, wy + 3, ww - 6, barH);
    label(ctx, pick(rng, WORDS), wx + 6, wy + 4, 8, "#ffffff", SANS, "700");
    for (let i = 0; i < 3; i++) {
      const bx = wx + ww - 3 - 11 * (i + 1);
      ctx.fillStyle = "#c0c0c0";
      ctx.fillRect(bx, wy + 4, 10, 9);
      bevel(ctx, bx, wy + 4, 10, 9);
    }
  } else {
    ctx.fillStyle = t.bar;
    ctx.fillRect(wx, wy, ww, barH);
    ctx.fillStyle = t.line;
    ctx.fillRect(wx, wy + barH, ww, 1);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = variant === "light" ? ["#ff5f57", "#febc2e", "#28c840"][i] : t.muted;
      ctx.beginPath();
      ctx.arc(wx + 9 + i * 9, wy + barH / 2, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1);
  }

  const bx = wx + (variant === "retro" ? 4 : 1);
  const by = wy + barH + (variant === "retro" ? 5 : 2);
  const bw = ww - (variant === "retro" ? 8 : 2);
  const bh = wh - barH - (variant === "retro" ? 9 : 3);
  const layout = pick(rng, ["cards", "form", "text", "table", "split", "cards"] as const);
  const m = 8;

  if (layout === "split" || (layout === "text" && chance(rng, 0.5))) {
    const sw = Math.round(bw * range(rng, 0.22, 0.32));
    ctx.fillStyle = variant === "dark" ? "#141414" : variant === "retro" ? "#ffffff" : "#efefef";
    ctx.fillRect(bx, by, sw, bh);
    ctx.fillStyle = t.line;
    ctx.fillRect(bx + sw, by, 1, bh);
    const rows = int(rng, 6, 14);
    for (let i = 0; i < rows; i++) {
      const y = by + m + i * 9;
      if (y > by + bh - 6) break;
      if (i === int(rng, 0, 2)) {
        ctx.fillStyle = variant === "retro" ? t.accent : t.line;
        ctx.fillRect(bx + 2, y - 2, sw - 4, 8);
      }
      ctx.fillStyle = t.muted;
      ctx.fillRect(bx + m, y, (sw - m * 2) * range(rng, 0.4, 0.9), 2);
    }
    if (variant === "retro") bevel(ctx, bx, by, sw, bh, false);
    label(ctx, pick(rng, WORDS), bx + sw + m, by + m - 2, 7, t.text, SANS, "600");
    bars(ctx, rng, bx + sw + m, by + m + 10, bw - sw - m * 2, int(rng, 12, 30), t.muted, 2, 3.5);
    return;
  }

  if (layout === "cards") {
    const cols = int(rng, 2, 4);
    const gap = 6;
    const cw = (bw - m * 2 - gap * (cols - 1)) / cols;
    let y = by + m;
    if (chance(rng, 0.6)) {
      label(ctx, pick(rng, WORDS), bx + m, y - 2, 7, t.text, SANS, "600");
      y += 12;
    }
    while (y < by + bh - 10) {
      const ch = cw * range(rng, 0.7, 1.3);
      for (let c = 0; c < cols; c++) {
        const x = bx + m + c * (cw + gap);
        ctx.fillStyle = variant === "dark" ? "#202020" : "#ffffff";
        rrect(ctx, x, y, cw, Math.min(ch, by + bh - y - m), variant === "retro" ? 0 : 3);
        ctx.fill();
        ctx.strokeStyle = t.line;
        ctx.stroke();
        const ih = ch * 0.55;
        const g = ctx.createLinearGradient(x, y, x + cw, y + ih);
        const hue = range(rng, 0, 360);
        g.addColorStop(0, hsl(hue, 18, variant === "dark" ? 30 : 68));
        g.addColorStop(1, hsl(hue + 40, 22, variant === "dark" ? 18 : 84));
        ctx.fillStyle = g;
        ctx.fillRect(x + 1, y + 1, cw - 2, Math.max(0, Math.min(ih, by + bh - y - m - 2)));
        if (y + ih + 12 < by + bh) bars(ctx, rng, x + 4, y + ih + 5, cw - 8, 2, t.muted, 2, 2.5, false);
      }
      y += ch + gap;
    }
    return;
  }

  if (layout === "form") {
    const dw = Math.min(bw - m * 2, range(rng, 0.6, 0.9) * bw);
    const dh = Math.min(bh - m * 2, range(rng, 0.5, 0.9) * bh);
    const dx = bx + (bw - dw) / 2;
    const dy = by + (bh - dh) / 2;
    ctx.fillStyle = variant === "dark" ? "#1e1e1e" : variant === "retro" ? "#c0c0c0" : "#ffffff";
    rrect(ctx, dx, dy, dw, dh, variant === "retro" ? 0 : 4);
    ctx.fill();
    if (variant === "retro") bevel(ctx, dx, dy, dw, dh);
    else {
      ctx.strokeStyle = t.border;
      ctx.stroke();
    }
    label(ctx, pick(rng, WORDS), dx + m, dy + m, 8, t.text, SANS, "700");
    let y = dy + m + 16;
    const rows = int(rng, 3, 7);
    for (let i = 0; i < rows && y + 14 < dy + dh - 20; i++) {
      ctx.fillStyle = t.muted;
      ctx.fillRect(dx + m, y + 3, dw * range(rng, 0.15, 0.3), 2);
      const kind = pick(rng, ["input", "check", "input", "select"]);
      const ix = dx + dw * 0.4;
      const iw = dw - dw * 0.4 - m;
      if (kind === "check") {
        ctx.fillStyle = variant === "dark" ? "#111" : "#fff";
        ctx.fillRect(ix, y, 8, 8);
        ctx.strokeStyle = t.line;
        ctx.strokeRect(ix + 0.5, y + 0.5, 7, 7);
        if (chance(rng, 0.6)) {
          ctx.fillStyle = t.accent;
          ctx.fillRect(ix + 2, y + 2, 4, 4);
        }
      } else {
        ctx.fillStyle = variant === "dark" ? "#111" : "#fff";
        ctx.fillRect(ix, y, iw, 9);
        if (variant === "retro") bevel(ctx, ix, y, iw, 9, false);
        else {
          ctx.strokeStyle = t.line;
          ctx.strokeRect(ix + 0.5, y + 0.5, iw - 1, 8);
        }
        ctx.fillStyle = t.muted;
        ctx.fillRect(ix + 3, y + 3.5, iw * range(rng, 0.2, 0.7), 2);
      }
      y += 14;
    }
    const btnW = 34;
    for (let i = 0; i < 2; i++) {
      const x = dx + dw - m - btnW - i * (btnW + 5);
      const yb = dy + dh - m - 11;
      const primary = i === 0;
      ctx.fillStyle = variant === "retro" ? "#c0c0c0" : primary ? t.accent : variant === "dark" ? "#2a2a2a" : "#f0f0f0";
      rrect(ctx, x, yb, btnW, 11, variant === "retro" ? 0 : 3);
      ctx.fill();
      if (variant === "retro") bevel(ctx, x, yb, btnW, 11);
      ctx.fillStyle = variant === "retro" ? "#000" : primary ? "#fff" : t.text;
      ctx.fillRect(x + 10, yb + 5, btnW - 20, 1.5);
    }
    return;
  }

  if (layout === "table") {
    const cols = int(rng, 3, 6);
    const rowH = 9;
    const cw = (bw - m * 2) / cols;
    let y = by + m;
    ctx.fillStyle = variant === "dark" ? "#222" : "#e6e6e6";
    ctx.fillRect(bx + m, y, bw - m * 2, rowH);
    for (let r = 0; y < by + bh - rowH; r++) {
      if (r > 0 && r % 2 === 0) {
        ctx.fillStyle = variant === "dark" ? "#1c1c1c" : "#f0f0f0";
        ctx.fillRect(bx + m, y, bw - m * 2, rowH);
      }
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = r === 0 ? t.text : t.muted;
        ctx.fillRect(bx + m + c * cw + 3, y + rowH / 2 - 1, cw * range(rng, 0.25, 0.8), 2);
      }
      ctx.fillStyle = t.line;
      ctx.fillRect(bx + m, y + rowH, bw - m * 2, 0.5);
      y += rowH;
    }
    for (let c = 1; c < cols; c++) {
      ctx.fillStyle = t.line;
      ctx.fillRect(bx + m + c * cw, by + m, 0.5, y - by - m);
    }
    return;
  }

  // plain text page
  label(ctx, pick(rng, WORDS), bx + m, by + m, 9, t.text, SANS, "700");
  bars(ctx, rng, bx + m, by + m + 16, bw - m * 2, int(rng, 14, 40), t.muted, 2, 3.5);
}

function bevel(ctx: Ctx, x: number, y: number, w: number, h: number, raised = true) {
  const light = raised ? "#ffffff" : "#808080";
  const dark = raised ? "#404040" : "#ffffff";
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = dark;
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x + w - 1, y, 1, h);
}

/* ------------------------------------------------------------------ ascii */

const RAMP_SHORT = " .:-=+*#%@";
const RAMP_LONG = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

function ascii(ctx: Ctx, w: number, h: number, rng: Rng) {
  const inverted = chance(rng, 0.2);
  const bg = inverted ? pick(rng, PAPERS) : pick(rng, DARKS);
  const fg = inverted ? INK : pick(rng, ["#d6d6d6", "#e8e8e8", "#c9c9c9", "#7ee787", "#ffb86b", "#9ad0ff"]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const size = pick(rng, [7, 8, 9]);
  ctx.font = `${size}px ${MONO}`;
  ctx.textBaseline = "top";
  const cw = ctx.measureText("M").width || size * 0.6;
  const ch = size * 1.15;
  const cols = Math.ceil(w / cw);
  const rows = Math.ceil(h / ch);
  const ramp = chance(rng, 0.5) ? RAMP_SHORT : RAMP_LONG;
  const noise = makeNoise(rng);
  const field = pick(rng, ["blobs", "sphere", "noise", "rings", "diagonal"] as const);
  const centers = Array.from({ length: int(rng, 1, 3) }, () => ({
    x: range(rng, 0.2, 0.8),
    y: range(rng, 0.2, 0.8),
    r: range(rng, 0.15, 0.4),
  }));
  const lx = range(rng, -1, 1);
  const ly = range(rng, -1, 1);
  const freq = range(rng, 1.5, 4);
  const density = (u: number, v: number): number => {
    switch (field) {
      case "blobs": {
        let s = 0;
        for (const c of centers) {
          const d = Math.hypot((u - c.x) * (w / h), v - c.y);
          s += Math.exp(-(d * d) / (c.r * c.r));
        }
        return clamp01(s);
      }
      case "sphere": {
        const c = centers[0];
        const dx = (u - c.x) * (w / h) / c.r;
        const dy = (v - c.y) / c.r;
        const rr = dx * dx + dy * dy;
        if (rr > 1) return 0;
        const nz = Math.sqrt(1 - rr);
        return clamp01(0.15 + 0.85 * clamp01(dx * lx * 0.6 + dy * ly * 0.6 + nz * 0.8));
      }
      case "noise":
        return clamp01((noise.fbm(u * freq, v * freq * (h / w), 4) - 0.25) * 1.8);
      case "rings": {
        const c = centers[0];
        const d = Math.hypot((u - c.x) * (w / h), v - c.y);
        return clamp01(0.5 + 0.5 * Math.sin(d * 40 - noise(u * 3, v * 3) * 4) * Math.exp(-d * 2.2));
      }
      case "diagonal":
        return clamp01(u * 0.6 + v * 0.4 + (noise(u * 6, v * 6) - 0.5) * 0.5);
    }
  };
  ctx.fillStyle = fg;
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const d = density((c + 0.5) / cols, (r + 0.5) / rows);
      const idx = Math.min(ramp.length - 1, Math.floor(d * (ramp.length - 0.001)));
      line += ramp[idx];
    }
    ctx.fillText(line, 0, r * ch);
  }
  if (!inverted && chance(rng, 0.5)) vignette(ctx, w, h, 0.5);
}

/* --------------------------------------------------------------- document */

function document_(ctx: Ctx, w: number, h: number, rng: Rng) {
  const paper = pick(rng, PAPERS);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, w, h);
  const m = w * range(rng, 0.08, 0.13);
  const inkLine = "rgba(25,25,25,0.72)";
  const variant = pick(rng, ["article", "two-col", "figure", "letter", "article"] as const);
  const lineH = 1.7;
  const gap = pick(rng, [3, 3.5, 4]);
  let y = m;

  if (variant !== "letter") {
    label(ctx, pick(rng, WORDS), m, y, chance(rng, 0.5) ? 14 : 11, "#1a1a1a", chance(rng, 0.6) ? SERIF : SANS, "700");
    y += 20;
    if (chance(rng, 0.5)) {
      ctx.fillStyle = "rgba(25,25,25,0.5)";
      ctx.fillRect(m, y, (w - m * 2) * range(rng, 0.3, 0.6), 2.5);
      y += 10;
    }
  } else {
    y += 18;
  }

  if (variant === "two-col") {
    const colW = (w - m * 2 - 8) / 2;
    const count = Math.floor((h - y - m) / (lineH + gap));
    bars(ctx, rng, m, y, colW, count, inkLine, lineH, gap);
    bars(ctx, rng, m + colW + 8, y, colW, count, inkLine, lineH, gap);
  } else if (variant === "figure") {
    const fh = h * range(rng, 0.25, 0.4);
    const fy = y + int(rng, 0, 4) * (lineH + gap) * 4;
    y = bars(ctx, rng, m, y, w - m * 2, Math.max(0, Math.floor((fy - y) / (lineH + gap))), inkLine, lineH, gap);
    ctx.strokeStyle = "rgba(25,25,25,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(m + 0.5, y + 0.5, w - m * 2 - 1, fh - 1);
    // a little line drawing inside
    ctx.beginPath();
    const n = int(rng, 4, 9);
    for (let i = 0; i < n; i++) {
      const x1 = m + range(rng, 0.1, 0.9) * (w - m * 2);
      const y1 = y + range(rng, 0.1, 0.9) * fh;
      if (chance(rng, 0.5)) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(m + range(rng, 0.1, 0.9) * (w - m * 2), y + range(rng, 0.1, 0.9) * fh);
      } else {
        ctx.moveTo(x1 + 6, y1);
        ctx.arc(x1, y1, range(rng, 3, fh * 0.3), 0, Math.PI * 2);
      }
    }
    ctx.stroke();
    y += fh + 6;
    ctx.fillStyle = "rgba(25,25,25,0.45)";
    ctx.fillRect(m, y, (w - m * 2) * 0.5, 1.5);
    y += 8;
    bars(ctx, rng, m, y, w - m * 2, Math.floor((h - y - m) / (lineH + gap)), inkLine, lineH, gap);
  } else if (variant === "letter") {
    bars(ctx, rng, m, y, (w - m * 2) * 0.55, int(rng, 3, 5), inkLine, lineH, gap, false);
    y += 40;
    bars(ctx, rng, m, y, w - m * 2, Math.floor((h - y - m * 2.5) / (lineH + gap * 1.6)), inkLine, lineH, gap * 1.6);
  } else {
    bars(ctx, rng, m, y, w - m * 2, Math.floor((h - y - m) / (lineH + gap)), inkLine, lineH, gap);
  }

  // page number + a faint scan shadow along one edge
  ctx.fillStyle = "rgba(25,25,25,0.5)";
  ctx.fillRect(w / 2 - 3, h - m * 0.55, 6, 1.5);
  const g = ctx.createLinearGradient(0, 0, w * 0.25, 0);
  g.addColorStop(0, "rgba(0,0,0,0.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w * 0.25, h);
}

/* ------------------------------------------------------------------- dots */

function dots(ctx: Ctx, w: number, h: number, rng: Rng) {
  ctx.fillStyle = pick(rng, DARKS);
  ctx.fillRect(0, 0, w, h);
  const variant = pick(rng, ["network", "network", "orbits", "lattice"] as const);
  const fg = pick(rng, ["#ffffff", "#e8e8e8", "#dcdcdc"]);

  if (variant === "lattice") {
    const step = range(rng, 10, 18);
    const noise = makeNoise(rng);
    ctx.fillStyle = fg;
    for (let y = step; y < h; y += step)
      for (let x = step; x < w; x += step) {
        const v = noise.fbm(x / 90, y / 90, 3);
        if (v < 0.42) continue;
        const r = clamp01((v - 0.4) * 3) * step * 0.28 + 0.4;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    return;
  }

  if (variant === "orbits") {
    const cx = w * range(rng, 0.3, 0.7);
    const cy = h * range(rng, 0.3, 0.7);
    const rings = int(rng, 3, 7);
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 0.8;
    for (let i = 1; i <= rings; i++) {
      const r = (Math.max(w, h) * 0.55 * i) / rings;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      const n = int(rng, 1, 4);
      for (let k = 0; k < n; k++) {
        const a = range(rng, 0, Math.PI * 2);
        glowDot(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, range(rng, 1.5, 4), fg);
      }
    }
    glowDot(ctx, cx, cy, range(rng, 4, 8), fg);
    return;
  }

  const n = int(rng, 18, 70);
  const clusters = Array.from({ length: int(rng, 1, 3) }, () => ({
    x: range(rng, 0.25, 0.75) * w,
    y: range(rng, 0.25, 0.75) * h,
    s: range(rng, 0.12, 0.3) * Math.max(w, h),
  }));
  const pts: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = pick(rng, clusters);
    const a = range(rng, 0, Math.PI * 2);
    const d = Math.abs(gauss(rng)) * c.s;
    const uniform = chance(rng, 0.25);
    pts.push({
      x: uniform ? range(rng, 0, w) : c.x + Math.cos(a) * d,
      y: uniform ? range(rng, 0, h) : c.y + Math.sin(a) * d,
      r: chance(rng, 0.12) ? range(rng, 3.5, 6) : range(rng, 1, 2.6),
    });
  }
  const thr = Math.max(w, h) * range(rng, 0.14, 0.24);
  ctx.strokeStyle = `rgba(255,255,255,${range(rng, 0.14, 0.3)})`;
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i];
      const b = pts[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < thr) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
  ctx.stroke();
  for (const p of pts) {
    if (p.r > 3) glowDot(ctx, p.x, p.y, p.r, fg);
    else {
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function glowDot(ctx: Ctx, x: number, y: number, r: number, color: string) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
  g.addColorStop(0, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function gauss(rng: Rng) {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ pixel */

const PIXEL_PALETTES = [
  ["#0f0f1b", "#565a75", "#c6b7be", "#fafbf6"],
  ["#211e20", "#555568", "#a0a08b", "#e9efec"],
  ["#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179", "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57"],
  ["#2b2b26", "#48413a", "#7a6a53", "#b3a06a", "#e0d3a7"],
  ["#081820", "#346856", "#88c070", "#e0f8d0"],
  ["#120f1a", "#3a2f4b", "#7c5f8c", "#c99ec8", "#f1e4f3"],
];

function pixel(ctx: Ctx, w: number, h: number, rng: Rng) {
  const pal = pick(rng, PIXEL_PALETTES);
  const cols = int(rng, 18, 36);
  const cell = w / cols;
  const rows = Math.ceil(h / cell);
  const variant = pick(rng, ["sprite", "landscape", "cave", "sprite"] as const);
  const px = (cx: number, cy: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(cx * cell), Math.floor(cy * cell), Math.ceil(cell), Math.ceil(cell));
  };

  if (variant === "sprite") {
    ctx.fillStyle = pal[0];
    ctx.fillRect(0, 0, w, h);
    const count = chance(rng, 0.5) ? 1 : int(rng, 2, 4);
    for (let s = 0; s < count; s++) {
      const size = count === 1 ? int(rng, 10, 16) : int(rng, 6, 10);
      const half = Math.ceil(size / 2);
      let grid = Array.from({ length: size }, () => Array.from({ length: half }, () => (chance(rng, 0.5) ? 1 : 0)));
      // one smoothing pass so shapes read as bodies rather than static
      grid = grid.map((row, y) =>
        row.map((v, x) => {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              n += grid[y + dy]?.[x + dx] ?? 0;
            }
          return n >= 4 ? 1 : n <= 1 ? 0 : v;
        }),
      );
      const ox = count === 1 ? Math.floor((cols - size) / 2) : int(rng, 1, cols - size - 1);
      const oy = count === 1 ? Math.floor((rows - size) / 2) : int(rng, 1, Math.max(1, rows - size - 1));
      const body = pick(rng, pal.slice(1));
      const detail = pick(rng, pal.slice(1));
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const gx = x < half ? x : size - 1 - x;
          if (!grid[y][gx]) continue;
          const edge = !grid[y - 1]?.[gx] || !grid[y + 1]?.[gx] || !(x < half ? grid[y][gx - 1] : grid[y][gx + 1] ?? grid[y][gx - 1]);
          px(ox + x, oy + y, edge && chance(rng, 0.3) ? detail : body);
        }
    }
    if (chance(rng, 0.5)) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = 0; y < h; y += 2) ctx.fillRect(0, y, w, 1);
    }
    return;
  }

  if (variant === "landscape") {
    const sky = pal.slice(-3);
    for (let y = 0; y < rows; y++) {
      const t = y / rows;
      px(0, y, sky[Math.min(sky.length - 1, Math.floor(t * sky.length * 1.4))]);
      ctx.fillRect(0, Math.floor(y * cell), w, Math.ceil(cell));
    }
    for (let i = 0; i < cols * 0.4; i++) px(int(rng, 0, cols - 1), int(rng, 0, Math.floor(rows * 0.5)), pal[pal.length - 1]);
    const layers = int(rng, 2, 4);
    for (let l = 0; l < layers; l++) {
      let y = rows * range(rng, 0.45, 0.65) + l * rows * 0.08;
      const color = pal[Math.max(0, Math.min(pal.length - 1, layers - l - 1))];
      for (let x = 0; x < cols; x++) {
        y += int(rng, -1, 1) * (chance(rng, 0.5) ? 1 : 0);
        y = Math.max(rows * 0.3, Math.min(rows - 2, y));
        for (let yy = Math.floor(y); yy < rows; yy++) px(x, yy, color);
      }
    }
    return;
  }

  // cave: cellular automaton
  let g = Array.from({ length: rows }, () => Array.from({ length: cols }, () => (chance(rng, 0.46) ? 1 : 0)));
  for (let it = 0; it < 4; it++) {
    g = g.map((row, y) =>
      row.map((_, x) => {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += g[y + dy]?.[x + dx] ?? 1;
        return n >= 5 ? 1 : 0;
      }),
    );
  }
  const a = pal[0];
  const b = pal[pal.length - 1];
  const c = pal[Math.floor(pal.length / 2)];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const v = g[y][x];
      const edge = v && (!g[y - 1]?.[x] || !g[y + 1]?.[x] || !g[y][x - 1] || !g[y][x + 1]);
      px(x, y, v ? (edge ? c : a) : b);
    }
}

/* ------------------------------------------------------------------- grid */

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789ЖФЯДЩЮБあかさたなはまアカサタナ&§¶@*";

function grid(ctx: Ctx, w: number, h: number, rng: Rng) {
  const dark = chance(rng, 0.45);
  const bg = dark ? pick(rng, DARKS) : pick(rng, PAPERS);
  const fg = dark ? "#e4e4e4" : INK;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const cols = int(rng, 4, 9);
  const cell = w / cols;
  const rows = Math.ceil(h / cell);
  const variant = pick(rng, ["specimen", "icons", "thumbs", "specimen"] as const);
  ctx.strokeStyle = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.14)";
  ctx.lineWidth = 1;
  for (let c = 1; c < cols; c++) {
    ctx.beginPath();
    ctx.moveTo(Math.round(c * cell) + 0.5, 0);
    ctx.lineTo(Math.round(c * cell) + 0.5, h);
    ctx.stroke();
  }
  for (let r = 1; r < rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(r * cell) + 0.5);
    ctx.lineTo(w, Math.round(r * cell) + 0.5);
    ctx.stroke();
  }
  const font = pick(rng, [SANS, SERIF, MONO]);
  const weight = pick(rng, ["400", "700", "900"]);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (chance(rng, 0.12)) continue;
      const x = c * cell;
      const y = r * cell;
      const cx = x + cell / 2;
      const cy = y + cell / 2;
      if (variant === "specimen") {
        ctx.font = `${weight} ${cell * range(rng, 0.5, 0.68)}px ${font}`;
        ctx.fillStyle = fg;
        ctx.fillText(GLYPHS[int(rng, 0, GLYPHS.length - 1)], cx, cy + cell * 0.03);
      } else if (variant === "icons") {
        const s = cell * range(rng, 0.25, 0.4);
        ctx.fillStyle = fg;
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1.2;
        const shape = int(rng, 0, 4);
        ctx.beginPath();
        if (shape === 0) ctx.arc(cx, cy, s, 0, Math.PI * 2);
        else if (shape === 1) ctx.rect(cx - s, cy - s, s * 2, s * 2);
        else if (shape === 2) {
          ctx.moveTo(cx, cy - s);
          ctx.lineTo(cx + s, cy + s);
          ctx.lineTo(cx - s, cy + s);
          ctx.closePath();
        } else if (shape === 3) {
          ctx.moveTo(cx - s, cy);
          ctx.lineTo(cx + s, cy);
          ctx.moveTo(cx, cy - s);
          ctx.lineTo(cx, cy + s);
        } else {
          ctx.moveTo(cx - s, cy + s);
          ctx.lineTo(cx + s, cy - s);
        }
        if (chance(rng, 0.4) && shape < 3) ctx.fill();
        else ctx.stroke();
      } else {
        const hue = range(rng, 0, 360);
        const g = ctx.createLinearGradient(x, y, x + cell, y + cell);
        g.addColorStop(0, hsl(hue, range(rng, 5, 30), dark ? range(rng, 25, 55) : range(rng, 45, 75)));
        g.addColorStop(1, hsl(hue + 30, range(rng, 5, 30), dark ? range(rng, 10, 30) : range(rng, 60, 90)));
        ctx.fillStyle = g;
        const inset = cell * 0.1;
        ctx.fillRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2);
      }
    }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

/* --------------------------------------------------------------- halftone */

function halftone(ctx: Ctx, w: number, h: number, rng: Rng) {
  const inverted = chance(rng, 0.25);
  const bg = inverted ? pick(rng, DARKS) : pick(rng, PAPERS);
  const ink = inverted ? "#ececec" : pick(rng, [INK, "#1d2a4a", "#4a1d1d", INK]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const noise = makeNoise(rng);
  const blobs = Array.from({ length: int(rng, 2, 5) }, () => ({
    x: range(rng, 0.2, 0.8),
    y: range(rng, 0.2, 0.8),
    rx: range(rng, 0.12, 0.35),
    ry: range(rng, 0.12, 0.35),
    a: range(rng, 0, Math.PI),
  }));
  const gx = range(rng, -0.6, 0.6);
  const gy = range(rng, -0.6, 0.6);
  const field = (u: number, v: number) => {
    let s = 0;
    for (const b of blobs) {
      const dx = u - b.x;
      const dy = v - b.y;
      const c = Math.cos(b.a);
      const sn = Math.sin(b.a);
      const rx = (dx * c + dy * sn) / b.rx;
      const ry = (-dx * sn + dy * c) / b.ry;
      const d = rx * rx + ry * ry;
      s += Math.exp(-d * 1.6) * (0.7 + 0.5 * (rx * gx + ry * gy));
    }
    s += (noise.fbm(u * 3, v * 3, 3) - 0.5) * 0.35;
    s += (u - 0.5) * gx * 0.4 + (v - 0.5) * gy * 0.4 + 0.08;
    return clamp01(s);
  };
  const variant = pick(rng, ["dots", "dots", "lines"] as const);
  ctx.fillStyle = ink;
  if (variant === "lines") {
    const spacing = range(rng, 3.5, 5.5);
    const step = 2;
    for (let y = 0; y < h + spacing; y += spacing)
      for (let x = 0; x < w; x += step) {
        const f = field(x / w, y / h);
        const t = f * spacing * 0.9;
        if (t < 0.25) continue;
        ctx.fillRect(x, y - t / 2, step + 0.3, t);
      }
    return;
  }
  const spacing = range(rng, 5, 8);
  const angle = range(rng, 0.2, 0.9);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const diag = Math.hypot(w, h);
  ctx.beginPath();
  for (let j = -diag; j < diag; j += spacing)
    for (let i = -diag; i < diag; i += spacing) {
      const x = w / 2 + i * ca - j * sa;
      const y = h / 2 + i * sa + j * ca;
      if (x < -spacing || y < -spacing || x > w + spacing || y > h + spacing) continue;
      const f = field(x / w, y / h);
      const r = Math.pow(f, 0.85) * spacing * 0.58;
      if (r < 0.3) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  ctx.fill();
}

/* ------------------------------------------------------------------- type */

function type_(ctx: Ctx, w: number, h: number, rng: Rng) {
  const scheme = pick(rng, ["paper", "paper", "dark", "accent"] as const);
  const bg = scheme === "paper" ? pick(rng, PAPERS) : scheme === "dark" ? pick(rng, DARKS) : pick(rng, ["#d6432b", "#2f4fd8", "#f2c53d", "#1f7a5a"]);
  const fg = scheme === "paper" ? INK : scheme === "dark" ? "#ececec" : bg === "#f2c53d" ? INK : "#f4f1ea";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const font = pick(rng, [SANS, SERIF, MONO, SANS]);
  const weight = pick(rng, ["400", "700", "800", "900"]);
  const count = int(rng, 1, 3);
  const size = Math.min(w, h) * range(rng, 0.62, 1.05) / Math.sqrt(count);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (chance(rng, 0.5)) {
    ctx.strokeStyle = scheme === "paper" ? "rgba(200,40,40,0.45)" : "rgba(255,255,255,0.2)";
    ctx.lineWidth = 0.7;
    for (const f of [0.3, 0.5, 0.7]) {
      ctx.beginPath();
      ctx.moveTo(0, h * f + 0.5);
      ctx.lineTo(w, h * f + 0.5);
      ctx.stroke();
    }
  }
  const glyphs = Array.from({ length: count }, () => GLYPHS[int(rng, 0, GLYPHS.length - 1)]);
  ctx.font = `${weight} ${size}px ${font}`;
  const total = glyphs.reduce((n, g) => n + ctx.measureText(g).width, 0) * 0.9;
  let x = w / 2 - total / 2;
  const y = h / 2 + size * 0.05;
  for (const g of glyphs) {
    const gw = ctx.measureText(g).width * 0.9;
    if (chance(rng, 0.3)) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1;
      ctx.strokeText(g, x + gw / 2 + size * 0.06, y + size * 0.06);
    }
    ctx.fillStyle = fg;
    ctx.fillText(g, x + gw / 2, y);
    x += gw;
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "top";
  ctx.font = `500 7px ${MONO}`;
  ctx.fillStyle = fg;
  ctx.globalAlpha = 0.7;
  ctx.fillText(`${pick(rng, ["Regular", "Medium", "Bold", "Display", "Mono", "Text"])} ${pick(rng, ["400", "500", "700", "900"])} · ${int(rng, 24, 144)}pt`, 8, h - 14);
  ctx.globalAlpha = 1;
}

/* ---------------------------------------------------------------- terrain */

function terrain(ctx: Ctx, w: number, h: number, rng: Rng) {
  const variant = pick(rng, ["ridges", "ridges", "contours", "planet"] as const);
  const noise = makeNoise(rng);

  if (variant === "planet") {
    ctx.fillStyle = pick(rng, DARKS);
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255,255,255,${range(rng, 0.2, 0.9)})`;
      ctx.fillRect(range(rng, 0, w), range(rng, 0, h), 1, 1);
    }
    const r = Math.min(w, h) * range(rng, 0.28, 0.42);
    const cx = w * range(rng, 0.35, 0.65);
    const cy = h * range(rng, 0.4, 0.6);
    const hue = range(rng, 0, 360);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    for (let y = cy - r; y <= cy + r; y += 1.5) {
      const v = noise.fbm(0.3, y / 18, 3);
      ctx.fillStyle = hsl(hue + v * 40, range(rng, 10, 30), 25 + v * 45);
      ctx.fillRect(cx - r, y, r * 2, 1.6);
    }
    const shade = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
    const lit = chance(rng, 0.5);
    shade.addColorStop(0, lit ? "rgba(0,0,0,0)" : "rgba(0,0,0,0.92)");
    shade.addColorStop(0.55, "rgba(0,0,0,0.15)");
    shade.addColorStop(1, lit ? "rgba(0,0,0,0.92)" : "rgba(0,0,0,0)");
    ctx.fillStyle = shade;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 1.6, r * 0.45, range(rng, -0.4, 0.4), 0, Math.PI * 2);
    if (chance(rng, 0.5)) ctx.stroke();
    return;
  }

  if (variant === "contours") {
    const dark = chance(rng, 0.6);
    ctx.fillStyle = dark ? pick(rng, DARKS) : pick(rng, PAPERS);
    ctx.fillRect(0, 0, w, h);
    const res = 5;
    const cols = Math.ceil(w / res) + 1;
    const rows = Math.ceil(h / res) + 1;
    const f = range(rng, 1.4, 3);
    const grid = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) grid[j * cols + i] = noise.fbm((i / cols) * f, (j / rows) * f * (h / w), 4);
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.55)" : "rgba(20,20,20,0.6)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let level = 0.3; level <= 0.72; level += 0.04) marchingSquares(ctx, grid, cols, rows, res, level);
    ctx.stroke();
    return;
  }

  // ridges
  const bg = pick(rng, DARKS);
  const fg = pick(rng, ["#f2f2f2", "#e0e0e0", "#cfd8dc"]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const rows = int(rng, 18, 42);
  const padX = w * 0.08;
  const padY = h * 0.12;
  const gap = (h - padY * 2) / rows;
  const amp = gap * range(rng, 3, 8);
  const freq = range(rng, 2, 5);
  ctx.lineWidth = 1;
  ctx.strokeStyle = fg;
  for (let r = 0; r < rows; r++) {
    const base = padY + r * gap + gap;
    ctx.beginPath();
    ctx.moveTo(padX, base);
    for (let x = padX; x <= w - padX; x += 2) {
      const u = (x - padX) / (w - padX * 2);
      const env = smoothstep(0, 0.28, u) * smoothstep(1, 0.72, u);
      const n = noise.fbm(u * freq, r * 0.11, 4);
      const spike = Math.pow(Math.max(0, n - 0.35), 1.6) * 4;
      ctx.lineTo(x, base - spike * amp * env);
    }
    ctx.lineTo(w - padX, base);
    ctx.lineTo(w - padX, h);
    ctx.lineTo(padX, h);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.stroke();
  }
}

function marchingSquares(ctx: Ctx, g: Float32Array, cols: number, rows: number, res: number, level: number) {
  const at = (i: number, j: number) => g[j * cols + i];
  const lerpP = (x1: number, y1: number, v1: number, x2: number, y2: number, v2: number) => {
    const t = (level - v1) / (v2 - v1 || 1e-6);
    return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  };
  for (let j = 0; j < rows - 1; j++)
    for (let i = 0; i < cols - 1; i++) {
      const tl = at(i, j);
      const tr = at(i + 1, j);
      const br = at(i + 1, j + 1);
      const bl = at(i, j + 1);
      const idx = (tl > level ? 8 : 0) | (tr > level ? 4 : 0) | (br > level ? 2 : 0) | (bl > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const x = i * res;
      const y = j * res;
      const top = lerpP(x, y, tl, x + res, y, tr);
      const right = lerpP(x + res, y, tr, x + res, y + res, br);
      const bottom = lerpP(x, y + res, bl, x + res, y + res, br);
      const left = lerpP(x, y, tl, x, y + res, bl);
      const seg = (a: number[], b: number[]) => {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      };
      switch (idx) {
        case 1: case 14: seg(left, bottom); break;
        case 2: case 13: seg(bottom, right); break;
        case 3: case 12: seg(left, right); break;
        case 4: case 11: seg(top, right); break;
        case 5: seg(left, top); seg(bottom, right); break;
        case 6: case 9: seg(top, bottom); break;
        case 7: case 8: seg(left, top); break;
        case 10: seg(top, right); seg(left, bottom); break;
      }
    }
}

/* -------------------------------------------------------------- dispatch */

const RENDERERS: Record<ArtStyle, (ctx: Ctx, w: number, h: number, rng: Rng) => void> = {
  photo,
  ui,
  ascii,
  document: document_,
  dots,
  pixel,
  grid,
  halftone,
  type: type_,
  terrain,
};

export function drawStyle(style: ArtStyle, ctx: Ctx, w: number, h: number, rng: Rng) {
  ctx.save();
  RENDERERS[style](ctx, w, h, rng);
  ctx.restore();
}
