import type { LooksElement } from "./data";

export interface CardLayout {
  el: LooksElement;
  index: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Media height inside the card; 0 for text-only cards. */
  imgH: number;
  /** Wrapped caption lines (already ellipsized). */
  lines: string[];
  /** Vertical offset of the caption block inside the card. */
  textY: number;
}

export interface GridLayout {
  cards: CardLayout[];
  height: number;
  cols: number;
  colW: number;
  /** Cards per column, ordered top to bottom (for keyboard navigation). */
  columns: CardLayout[][];
}

export interface LayoutOptions {
  width: number;
  pad: number;
  gap: number;
  minColW: number;
  lineH: number;
  maxLines: number;
  showCaptions: boolean;
  showAuthors: boolean;
  /** Text measurer for the caption font (usually ctx.measureText(...).width). */
  measure: (text: string) => number;
}

export const CARD_PAD_X = 12;
export const CARD_PAD_TOP = 11;
export const CARD_PAD_BOTTOM = 12;
export const AUTHOR_GAP = 6;
export const AUTHOR_LINE_H = 14;

const wrapCache = new Map<string, string[]>();

/** Greedy word wrap with a trailing ellipsis when the text is cut. */
export function wrapText(text: string, maxWidth: number, maxLines: number, measure: (s: string) => number): string[] {
  const key = `${maxWidth.toFixed(1)}|${maxLines}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let cut = false;

  const pushLine = (line: string) => {
    lines.push(line);
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      pushLine(current);
      current = "";
      if (lines.length === maxLines) {
        cut = true;
        break;
      }
    }
    // Word alone is too wide: hard-break by characters.
    if (measure(word) > maxWidth) {
      let chunk = "";
      for (const ch of word) {
        if (measure(chunk + ch) <= maxWidth) chunk += ch;
        else {
          pushLine(chunk);
          chunk = ch;
          if (lines.length === maxLines) {
            cut = true;
            break;
          }
        }
      }
      if (cut) break;
      current = chunk;
    } else {
      current = word;
    }
  }
  if (!cut && current) {
    if (lines.length < maxLines) pushLine(current);
    else cut = true;
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    cut = true;
  }
  if (cut && lines.length) {
    let last = lines[lines.length - 1].replace(/[\s.,;:!?]+$/, "");
    while (last.length && measure(`${last}…`) > maxWidth) last = last.slice(0, -1).replace(/\s+$/, "");
    lines[lines.length - 1] = `${last}…`;
  }
  wrapCache.set(key, lines);
  return lines;
}

export function layoutGrid(elements: LooksElement[], o: LayoutOptions): GridLayout {
  const inner = Math.max(0, o.width - o.pad * 2);
  const cols = Math.max(1, Math.floor((inner + o.gap) / (o.minColW + o.gap)));
  const colW = Math.floor((inner - o.gap * (cols - 1)) / cols);
  const heights = new Array<number>(cols).fill(o.pad);
  const cards: CardLayout[] = [];
  const columns: CardLayout[][] = Array.from({ length: cols }, () => []);
  const textW = colW - CARD_PAD_X * 2;

  elements.forEach((el, index) => {
    let col = 0;
    for (let c = 1; c < cols; c++) if (heights[c] < heights[col] - 0.5) col = c;

    const isText = el.kind === "text";
    const imgH = isText ? 0 : Math.round(Math.min(Math.max(colW * el.aspect, colW * 0.45), colW * 1.6));
    const lines = o.showCaptions || isText ? wrapText(el.caption, textW, isText ? 8 : o.maxLines, o.measure) : [];
    const hasText = lines.length > 0 || o.showAuthors;
    let h = imgH;
    let textY = imgH;
    if (hasText) {
      textY = imgH + (isText ? CARD_PAD_TOP + 6 : CARD_PAD_TOP);
      h = textY + lines.length * o.lineH;
      if (o.showAuthors) h += (lines.length ? AUTHOR_GAP : 0) + AUTHOR_LINE_H;
      h += isText ? CARD_PAD_BOTTOM + 6 : CARD_PAD_BOTTOM;
    }
    const card: CardLayout = {
      el,
      index,
      col,
      x: o.pad + col * (colW + o.gap),
      y: heights[col],
      w: colW,
      h,
      imgH,
      lines,
      textY,
    };
    cards.push(card);
    columns[col].push(card);
    heights[col] += h + o.gap;
  });

  const height = cards.length ? Math.max(...heights) - o.gap + o.pad : o.pad * 2;
  return { cards, height, cols, colW, columns };
}

export function hitTest(layout: GridLayout, x: number, y: number): CardLayout | null {
  for (const c of layout.cards) {
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c;
  }
  return null;
}

export type NavDir = "up" | "down" | "left" | "right";

export function neighbor(layout: GridLayout, from: CardLayout, dir: NavDir): CardLayout | null {
  const column = layout.columns[from.col];
  const pos = column.indexOf(from);
  if (dir === "up") return pos > 0 ? column[pos - 1] : null;
  if (dir === "down") return pos < column.length - 1 ? column[pos + 1] : null;
  const targetCol = dir === "left" ? from.col - 1 : from.col + 1;
  if (targetCol < 0 || targetCol >= layout.cols) return null;
  const cy = from.y + from.h / 2;
  let best: CardLayout | null = null;
  let bestD = Infinity;
  for (const c of layout.columns[targetCol]) {
    const d = Math.abs(c.y + c.h / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
