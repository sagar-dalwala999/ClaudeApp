/**
 * Procedural thumbnail engine.
 *
 * Every element in the archive gets a deterministic piece of "media" drawn
 * straight into an offscreen canvas from its seed, so the app needs no image
 * assets and no network. Generation is queued and time-boxed so scrolling
 * through hundreds of never-seen cards stays smooth.
 */
import type { LooksElement } from "./data";
import { mulberry32 } from "./random";
import { drawStyle } from "./artStyles";

export const ART_WIDTH = 320;

type Listener = () => void;

const cache = new Map<string, HTMLCanvasElement>();
const queue: { el: LooksElement; width: number }[] = [];
const queued = new Set<string>();
const listeners = new Set<Listener>();
let scheduled = false;

const keyOf = (el: LooksElement, width: number) => `${el.id}@${width}`;

export function subscribeArt(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Synchronously render an element's media at the given pixel width. */
export function renderArt(el: LooksElement, width = ART_WIDTH): HTMLCanvasElement {
  const key = keyOf(el, width);
  const hit = cache.get(key);
  if (hit) return hit;
  const w = Math.round(width);
  const h = Math.max(8, Math.round(width * el.aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const rng = mulberry32(el.seed);
    drawStyle(el.style, ctx, w, h, rng);
  }
  cache.set(key, canvas);
  return canvas;
}

/**
 * Returns the cached media for an element, or null while it is being
 * generated. Callers redraw when `subscribeArt` fires.
 */
export function getArt(el: LooksElement, width = ART_WIDTH): HTMLCanvasElement | null {
  const key = keyOf(el, width);
  const hit = cache.get(key);
  if (hit) return hit;
  if (!queued.has(key)) {
    queued.add(key);
    queue.push({ el, width });
    schedule();
  }
  return null;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    const start = performance.now();
    let produced = 0;
    // LIFO: whatever was requested most recently is what is on screen now.
    while (queue.length && performance.now() - start < 7) {
      const job = queue.pop()!;
      queued.delete(keyOf(job.el, job.width));
      renderArt(job.el, job.width);
      produced++;
    }
    if (produced) listeners.forEach((fn) => fn());
    if (queue.length) schedule();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/** Draw `img` into a box using CSS `object-fit: cover` semantics. */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}
