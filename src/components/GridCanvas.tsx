"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClientItem } from "@/lib/item";
import { ART_WIDTH, drawCover, getArt, subscribeArt } from "@/lib/art";
import {
  AUTHOR_GAP,
  CARD_PAD_X,
  hitTest,
  layoutGrid,
  neighbor,
  type CardLayout,
  type GridLayout,
  type NavDir,
} from "@/lib/layout";
import { UI_FONT, type Settings } from "@/lib/settings";

export interface GridApi {
  navigate(dir: NavDir): void;
  /** Ensure the selected card is visible. */
  reveal(id: string): void;
}

interface Props {
  elements: ClientItem[];
  settings: Settings;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpen(el: ClientItem): void;
  emptyMessage?: string;
  apiRef: React.RefObject<GridApi | null>;
}

const LINE_H = 15;
const PAD = 14;
const COLORS = {
  bg: "#0b0b0b",
  card: "#151515",
  cardHover: "#1b1b1b",
  border: "#232323",
  borderHover: "#2e2e2e",
  selected: "#8a8a8a",
  text: "#d4d4d4",
  textStrong: "#ececec",
  dim: "#7c7c7c",
  placeholder: "#1a1a1a",
};

let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): (s: string) => number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  const ctx = measureCtx;
  if (!ctx) return (s) => s.length * 6.6;
  ctx.font = UI_FONT;
  return (s) => ctx.measureText(s).width;
}

export function GridCanvas({ elements, settings, selectedId, onSelect, onOpen, apiRef, emptyMessage }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const scrollTopRef = useRef(0);
  const hoverRef = useRef<string | null>(null);
  const rafRef = useRef(0);
  const layoutRef = useRef<GridLayout | null>(null);
  const pressRef = useRef<{ x: number; y: number; id: string | null } | null>(null);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!size.w) return null;
    return layoutGrid(elements, {
      width: size.w,
      pad: PAD,
      gap: settings.gap,
      minColW: settings.colW,
      lineH: LINE_H,
      maxLines: 3,
      showCaptions: settings.showCaptions,
      showAuthors: settings.showAuthors,
      measure: measurer(),
    });
  }, [elements, size.w, settings.gap, settings.colW, settings.showCaptions, settings.showAuthors]);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // Reset scroll when the element set changes (switching collections).
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = 0;
      scrollTopRef.current = 0;
    }
  }, [elements]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const lay = layoutRef.current;
    if (!canvas || !lay || !size.w || !size.h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = size.w;
    const H = size.h;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const top = scrollTopRef.current;
    const bottom = top + H;
    const radius = settings.rounded ? 4 : 0;
    const hover = hoverRef.current;

    // Warm the cache one screen ahead/behind (requested first so the visible
    // cards, requested last, win the LIFO queue).
    for (const c of lay.cards) {
      if (c.imgH && ((c.y + c.h >= top - H && c.y < top) || (c.y > bottom && c.y <= bottom + H))) getArt(c.el, ART_WIDTH);
    }

    ctx.font = UI_FONT;
    ctx.textBaseline = "top";
    for (const c of lay.cards) {
      if (c.y + c.h < top || c.y > bottom) continue;
      const x = c.x;
      const y = c.y - top;
      const isHover = hover === c.el.id;
      const isSelected = selectedId === c.el.id;

      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, c.w - 1, c.h - 1, radius);
      ctx.fillStyle = isHover ? COLORS.cardHover : COLORS.card;
      ctx.fill();

      if (c.imgH) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, c.w - 2, c.imgH - 1, [radius, radius, 0, 0]);
        ctx.clip();
        const img = getArt(c.el, ART_WIDTH);
        if (img) drawCover(ctx, img, x + 1, y + 1, c.w - 2, c.imgH - 1);
        else {
          ctx.fillStyle = COLORS.placeholder;
          ctx.fillRect(x + 1, y + 1, c.w - 2, c.imgH - 1);
        }
        if (isHover) {
          ctx.fillStyle = "rgba(255,255,255,0.04)";
          ctx.fillRect(x + 1, y + 1, c.w - 2, c.imgH - 1);
        }
        ctx.restore();
        if (c.el.kind === "video") drawPlay(ctx, x + c.w / 2, y + c.imgH / 2);
        if (c.lines.length || settings.showAuthors) {
          ctx.fillStyle = "rgba(255,255,255,0.05)";
          ctx.fillRect(x + 1, y + c.imgH, c.w - 2, 1);
        }
      }

      const tx = x + CARD_PAD_X;
      let ty = y + c.textY;
      if (c.lines.length) {
        ctx.fillStyle = c.el.kind === "text" ? COLORS.textStrong : COLORS.text;
        for (const line of c.lines) {
          ctx.fillText(line, tx, ty + 1);
          ty += LINE_H;
        }
        ty += AUTHOR_GAP;
      }
      if (settings.showAuthors) {
        ctx.fillStyle = COLORS.dim;
        ctx.fillText(`by @${c.el.author}`, tx, ty + 1, Math.max(0, c.w - CARD_PAD_X * 2));
      }

      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, c.w - 1, c.h - 1, radius);
      ctx.strokeStyle = isSelected ? COLORS.selected : isHover ? COLORS.borderHover : COLORS.border;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (isSelected) {
        ctx.beginPath();
        ctx.roundRect(x - 1.5, y - 1.5, c.w + 3, c.h + 3, radius + 2);
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.stroke();
      }
    }
  }, [size.w, size.h, selectedId, settings.rounded, settings.showAuthors]);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw, layout]);

  useEffect(() => subscribeArt(requestDraw), [requestDraw]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const reveal = useCallback(
    (id: string) => {
      const lay = layoutRef.current;
      const scroller = scrollerRef.current;
      if (!lay || !scroller) return;
      const card = lay.cards.find((c) => c.el.id === id);
      if (!card) return;
      const top = scroller.scrollTop;
      if (card.y < top + PAD) scroller.scrollTo({ top: Math.max(0, card.y - PAD) });
      else if (card.y + card.h > top + size.h - PAD) scroller.scrollTo({ top: card.y + card.h - size.h + PAD });
    },
    [size.h],
  );

  useEffect(() => {
    apiRef.current = {
      navigate(dir) {
        const lay = layoutRef.current;
        if (!lay || !lay.cards.length) return;
        const current = selectedId ? lay.cards.find((c) => c.el.id === selectedId) : null;
        let next: CardLayout | null;
        if (!current) {
          // Start from the first card currently on screen.
          const top = scrollTopRef.current;
          next = lay.cards.find((c) => c.y + c.h >= top) ?? lay.cards[0];
        } else {
          next = neighbor(lay, current, dir);
        }
        if (next) {
          onSelect(next.el.id);
          reveal(next.el.id);
        }
      },
      reveal,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, onSelect, reveal, selectedId]);

  const cardAt = (e: React.MouseEvent) => {
    const lay = layoutRef.current;
    const canvas = canvasRef.current;
    if (!lay || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return hitTest(lay, e.clientX - rect.left, e.clientY - rect.top + scrollTopRef.current);
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    requestDraw();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const card = cardAt(e);
    const id = card?.el.id ?? null;
    if (id !== hoverRef.current) {
      hoverRef.current = id;
      if (canvasRef.current) canvasRef.current.style.cursor = id ? "pointer" : "default";
      requestDraw();
    }
  };

  const onMouseLeave = () => {
    if (hoverRef.current !== null) {
      hoverRef.current = null;
      requestDraw();
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    pressRef.current = { x: e.clientX, y: e.clientY, id: cardAt(e)?.el.id ?? null };
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || e.button !== 0) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) return;
    const card = cardAt(e);
    const id = card?.el.id ?? null;
    if (id !== press.id) return;
    onSelect(id === selectedId && e.detail === 1 ? null : id);
    if (card && e.detail >= 2) onOpen(card.el);
  };

  const totalHeight = Math.max(layout?.height ?? 0, size.h);

  return (
    <div
      ref={scrollerRef}
      className="grid-scroller"
      onScroll={onScroll}
      tabIndex={-1}
      role="grid"
      aria-label="Elements"
      aria-rowcount={elements.length}
    >
      <div className="grid-spacer" style={{ height: totalHeight }}>
        <canvas
          ref={canvasRef}
          className="grid-canvas"
          style={{ height: size.h }}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
        />
      </div>
      {elements.length === 0 && <div className="main-empty">{emptyMessage ?? "No elements match."}</div>}
    </div>
  );
}

function drawPlay(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy - 6);
  ctx.lineTo(cx + 6, cy);
  ctx.lineTo(cx - 4, cy + 6);
  ctx.closePath();
  ctx.fillStyle = "#f2f2f2";
  ctx.fill();
}
