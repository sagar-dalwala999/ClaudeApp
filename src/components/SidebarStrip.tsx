"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClientItem } from "@/lib/item";
import { drawCover, getArt, subscribeArt } from "@/lib/art";

interface Props {
  elements: ClientItem[];
  thumb?: number;
  gap?: number;
}

const STRIP_ART_W = 96;

/** A row of square thumbnails, drawn on one canvas per collection row. */
export function SidebarStrip({ elements, thumb = 26, gap = 2 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const rafRef = useRef(0);

  useLayoutEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const h = thumb + 4;
    const count = Math.min(elements.length, Math.max(0, Math.floor((width + gap) / (thumb + gap))));
    const w = Math.max(1, count * (thumb + gap) - gap);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < count; i++) {
      const el = elements[i];
      const x = i * (thumb + gap);
      const y = 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, thumb, thumb, 2);
      ctx.clip();
      if (el.kind === "text") {
        ctx.fillStyle = "#1e1e1e";
        ctx.fillRect(x, y, thumb, thumb);
        ctx.fillStyle = "#6a6a6a";
        ctx.font = `${Math.round(thumb * 0.6)}px Georgia, serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("“", x + thumb / 2, y + thumb * 0.62);
      } else {
        const img = getArt(el, STRIP_ART_W);
        if (img) drawCover(ctx, img, x, y, thumb, thumb);
        else {
          ctx.fillStyle = "#1a1a1a";
          ctx.fillRect(x, y, thumb, thumb);
        }
      }
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, thumb - 1, thumb - 1, 2);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, [elements, width, thumb, gap]);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);
  useEffect(() => subscribeArt(requestDraw), [requestDraw]);
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return (
    <div className="strip" aria-hidden="true">
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}
