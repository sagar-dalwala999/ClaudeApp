/**
 * Thumbnail engine.
 *
 * Two sources, one cache:
 *
 *  1. the archived picture, loaded from our own `/api/img` — a canvas-sized
 *     copy of the decoded image, so the grid can blit it per frame
 *  2. the procedural renderer, which is what an item shows while its picture
 *     loads, and permanently for links that have no picture at all
 *
 * Everything stays in memory as canvases (never DOM images) so the masonry
 * grid, the graph and the sidebar strips can keep drawing synchronously.
 * Loading and procedural generation are both queued and time-boxed, which is
 * what keeps scrolling through hundreds of cards smooth.
 */
import type { ClientItem } from "./item";
import { mediaUrl } from "./item";
import { mulberry32 } from "./random";
import { drawStyle } from "./artStyles";

export const ART_WIDTH = 320;

type Listener = () => void;

const cache = new Map<string, HTMLCanvasElement>();
/** Which item each cached canvas belongs to, so we can invalidate on load. */
const cacheOwner = new Map<string, string>();
const images = new Map<string, HTMLImageElement | "error">();
const loading = new Set<string>();
const queue: Array<{ item: ClientItem; width: number }> = [];
const queued = new Set<string>();
const listeners = new Set<Listener>();
let scheduled = false;

const keyOf = (item: ClientItem, width: number) => `${item.id}@${width}`;

export function subscribeArt(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  for (const fn of listeners) fn();
}

function remoteUrlFor(item: ClientItem): string | null {
  const first = item.media.find((m) => m.storageKey);
  return first ? mediaUrl(first, "card") : null;
}

function dropCached(itemId: string) {
  for (const [key, owner] of cacheOwner) {
    if (owner === itemId) {
      cache.delete(key);
      cacheOwner.delete(key);
    }
  }
}

function startLoad(item: ClientItem, remote: string) {
  if (loading.has(remote) || images.has(remote)) return;
  loading.add(remote);
  const image = new Image();
  image.decoding = "async";
  image.onload = () => {
    loading.delete(remote);
    images.set(remote, image);
    dropCached(item.id);
    notify();
  };
  image.onerror = () => {
    loading.delete(remote);
    images.set(remote, "error");
    notify();
  };
  image.src = remote;
}

/** Canvas holding a decoded image, sized to the requested width. */
function canvasFromImage(item: ClientItem, image: HTMLImageElement, width: number): HTMLCanvasElement {
  const naturalWidth = image.naturalWidth || width;
  const naturalHeight = image.naturalHeight || Math.round(width * item.aspect);
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round(width * (naturalHeight / naturalWidth)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = item.media[0]?.placeholder ?? "#151515";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
  }
  return canvas;
}

/**
 * The dominant colour of the picture we are still fetching, so a card never
 * flashes grey on the way in.
 */
function provisional(item: ClientItem, width: number): HTMLCanvasElement {
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round(width * item.aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const colour = item.media[0]?.placeholder;
  if (ctx) {
    ctx.fillStyle = colour ?? "#141414";
    ctx.fillRect(0, 0, w, h);
  }
  return canvas;
}

/** Synchronously renders the procedural placeholder for an item. */
export function renderArt(item: ClientItem, width = ART_WIDTH): HTMLCanvasElement {
  const key = keyOf(item, width);
  const hit = cache.get(key);
  if (hit) return hit;
  const w = Math.round(width);
  const h = Math.max(8, Math.round(width * item.aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const rng = mulberry32(item.seed);
    try {
      drawStyle(item.style, ctx, w, h, rng);
    } catch {
      ctx.fillStyle = "#141414";
      ctx.fillRect(0, 0, w, h);
    }
  }
  cache.set(key, canvas);
  cacheOwner.set(key, item.id);
  return canvas;
}

/**
 * Returns a canvas for the item, or null while its procedural placeholder is
 * still being generated. Callers redraw when `subscribeArt` fires.
 */
export function getArt(item: ClientItem, width = ART_WIDTH): HTMLCanvasElement | null {
  const key = keyOf(item, width);
  const hit = cache.get(key);
  if (hit) return hit;

  const remote = remoteUrlFor(item);
  if (remote) {
    const loaded = images.get(remote);
    if (loaded === undefined) {
      startLoad(item, remote);
      const placeholder = provisional(item, width);
      cache.set(key, placeholder);
      cacheOwner.set(key, item.id);
      return placeholder;
    }
    if (loaded === "error") {
      // The download failed: fall through to the procedural renderer.
    } else {
      const canvas = canvasFromImage(item, loaded, width);
      cache.set(key, canvas);
      cacheOwner.set(key, item.id);
      return canvas;
    }
  }

  if (!queued.has(key)) {
    queued.add(key);
    queue.push({ item, width });
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
      queued.delete(keyOf(job.item, job.width));
      renderArt(job.item, job.width);
      produced++;
    }
    if (produced) notify();
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
  if (!img.width || !img.height) return;
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

/** Drops everything cached; used when the archive is reloaded wholesale. */
export function clearArtCache(): void {
  cache.clear();
  cacheOwner.clear();
  images.clear();
  loading.clear();
  queue.length = 0;
  queued.clear();
  notify();
}
