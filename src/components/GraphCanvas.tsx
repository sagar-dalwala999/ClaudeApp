"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClientItem } from "@/lib/item";
import { drawCover, getArt, subscribeArt } from "@/lib/art";
import type { NavDir } from "@/lib/layout";
import { hashString, mulberry32 } from "@/lib/random";
import { UI_FONT } from "@/lib/settings";

export interface GraphApi {
  navigate(dir: NavDir): void;
  reveal(id: string): void;
}

interface Props {
  elements: ClientItem[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpen(el: ClientItem): void;
  emptyMessage?: string;
  apiRef: React.RefObject<GraphApi | null>;
}

interface Node {
  el: ClientItem;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  degree: number;
  pinned: boolean;
}

interface Edge {
  a: number;
  b: number;
  kind: "author" | "tag";
}

interface Graph {
  nodes: Node[];
  edges: Edge[];
  byId: Map<string, Node>;
}

const MAX_NODES = 600;
const THUMB_W = 96;

function buildGraph(elements: ClientItem[], w: number, h: number): Graph {
  const els = elements.slice(0, MAX_NODES);
  const rng = mulberry32(hashString(`${els.length}:${els[0]?.id ?? ""}:${els[els.length - 1]?.id ?? ""}`));
  const n = Math.max(1, els.length);
  const spread = Math.min(w, h) * 0.42;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const nodes: Node[] = els.map((el, i) => {
    const a = i * golden;
    const r = Math.sqrt((i + 0.5) / n) * spread;
    return { el, x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r, vx: 0, vy: 0, r: 14, degree: 0, pinned: false };
  });
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const link = (a: number, b: number, kind: Edge["kind"]) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind });
    nodes[a].degree++;
    nodes[b].degree++;
  };
  const group = (keyOf: (el: ClientItem) => string[]) => {
    const groups = new Map<string, number[]>();
    els.forEach((el, i) => {
      for (const k of keyOf(el)) {
        const g = groups.get(k);
        if (g) g.push(i);
        else groups.set(k, [i]);
      }
    });
    return groups;
  };
  for (const members of group((el) => [el.author]).values()) {
    for (let i = 1; i < members.length; i++) link(members[i - 1], members[i], "author");
    if (members.length > 3) link(members[0], members[Math.floor(rng() * members.length)], "author");
  }
  for (const members of group((el) => el.tags).values()) {
    for (let i = 1; i < members.length; i++) if (rng() < 0.35) link(members[i - 1], members[i], "tag");
  }
  for (const node of nodes) node.r = 13 + Math.min(node.degree, 8) * 1.6;
  return { nodes, edges, byId: new Map(nodes.map((nd) => [nd.el.id, nd])) };
}

function tick(g: Graph, w: number, h: number, alpha: number) {
  const { nodes, edges } = g;
  const n = nodes.length;
  if (!n) return;
  const k = Math.sqrt((w * h) / n) * 1.1;
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = (i - j) * 0.01;
        dy = 0.01;
        d2 = 0.0002;
      }
      const d = Math.sqrt(d2);
      const minD = a.r + b.r + 6;
      const f = (k * k) / d2 + (d < minD ? (minD - d) * 0.6 : 0);
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      fx[i] += ux;
      fy[i] += uy;
      fx[j] -= ux;
      fy[j] -= uy;
    }
  }
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const f = ((d * d) / k) * (e.kind === "author" ? 0.9 : 0.5) * 0.22;
    const ux = (dx / d) * f;
    const uy = (dy / d) * f;
    fx[e.a] += ux;
    fy[e.a] += uy;
    fx[e.b] -= ux;
    fy[e.b] -= uy;
  }
  const cx = w / 2;
  const cy = h / 2;
  const maxV = k * 0.35;
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    if (nd.pinned) continue;
    fx[i] += (cx - nd.x) * 0.018 * k * 0.01;
    fy[i] += (cy - nd.y) * 0.018 * k * 0.01;
    nd.vx = (nd.vx + fx[i] * alpha * 0.02) * 0.55;
    nd.vy = (nd.vy + fy[i] * alpha * 0.02) * 0.55;
    const v = Math.hypot(nd.vx, nd.vy);
    if (v > maxV) {
      nd.vx = (nd.vx / v) * maxV;
      nd.vy = (nd.vy / v) * maxV;
    }
    nd.x += nd.vx;
    nd.y += nd.vy;
  }
}

export function GraphCanvas({ elements, selectedId, onSelect, onOpen, apiRef, emptyMessage }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const graphRef = useRef<Graph | null>(null);
  const viewRef = useRef({ x: 0, y: 0, zoom: 1 });
  const alphaRef = useRef(1);
  const hoverRef = useRef<Node | null>(null);
  const dragRef = useRef<{ mode: "pan" | "node"; node?: Node; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const rafRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const g = graphRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, size.w, size.h);
    if (!g) return;
    const { x: px, y: py, zoom } = viewRef.current;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * px, dpr * py);

    // faint dot grid so panning has a reference
    const step = 40;
    const x0 = Math.floor(-px / zoom / step) * step;
    const y0 = Math.floor(-py / zoom / step) * step;
    const x1 = (size.w - px) / zoom;
    const y1 = (size.h - py) / zoom;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    if (zoom > 0.45) {
      for (let x = x0; x < x1; x += step) for (let y = y0; y < y1; y += step) ctx.fillRect(x, y, 1 / zoom, 1 / zoom);
    }

    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    for (const e of g.edges) {
      if (e.kind !== "tag") continue;
      ctx.moveTo(g.nodes[e.a].x, g.nodes[e.a].y);
      ctx.lineTo(g.nodes[e.b].x, g.nodes[e.b].y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.stroke();
    ctx.beginPath();
    for (const e of g.edges) {
      if (e.kind !== "author") continue;
      ctx.moveTo(g.nodes[e.a].x, g.nodes[e.a].y);
      ctx.lineTo(g.nodes[e.b].x, g.nodes[e.b].y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.stroke();

    const hover = hoverRef.current;
    for (const nd of g.nodes) {
      const s = nd.r * 2;
      const x = nd.x - nd.r;
      const y = nd.y - nd.r;
      if (x + s < x0 - step || y + s < y0 - step || x > x1 + step || y > y1 + step) continue;
      const isSel = nd.el.id === selectedId;
      const isHover = nd === hover;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, s, s, 4);
      ctx.clip();
      if (nd.el.kind === "text") {
        ctx.fillStyle = "#1c1c1c";
        ctx.fillRect(x, y, s, s);
        ctx.fillStyle = "#8a8a8a";
        ctx.font = `${Math.round(s * 0.55)}px Georgia, serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("“", nd.x, nd.y + s * 0.18);
      } else {
        const img = getArt(nd.el, THUMB_W);
        if (img) drawCover(ctx, img, x, y, s, s);
        else {
          ctx.fillStyle = "#1a1a1a";
          ctx.fillRect(x, y, s, s);
        }
      }
      if (isHover) {
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fillRect(x, y, s, s);
      }
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(x + 0.5 / zoom, y + 0.5 / zoom, s - 1 / zoom, s - 1 / zoom, 4);
      ctx.strokeStyle = isSel ? "#f0f0f0" : isHover ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.14)";
      ctx.lineWidth = (isSel ? 1.5 : 1) / zoom;
      ctx.stroke();
      if (nd.el.kind === "video") {
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(nd.x - 2, nd.y - 3);
        ctx.lineTo(nd.x + 3, nd.y);
        ctx.lineTo(nd.x - 2, nd.y + 3);
        ctx.closePath();
        ctx.fillStyle = "#fff";
        ctx.fill();
      }
    }

    // Legend in screen space.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = UI_FONT;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = "#7c7c7c";
    const authorEdges = g.edges.reduce((n, e) => n + (e.kind === "author" ? 1 : 0), 0);
    ctx.fillText(
      `${g.nodes.length} nodes · ${authorEdges} by author · ${g.edges.length - authorEdges} by tag · drag to pan · scroll to zoom${
        elements.length > g.nodes.length ? ` · showing first ${g.nodes.length}` : ""
      }`,
      14,
      size.h - 22,
    );

    // Tooltip in screen space.
    if (hover) {
      ctx.font = UI_FONT;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      const caption = hover.el.caption.length > 56 ? `${hover.el.caption.slice(0, 55).trimEnd()}…` : hover.el.caption;
      const author = `by @${hover.el.author}`;
      const wText = Math.max(ctx.measureText(caption).width, ctx.measureText(author).width) + 20;
      const sx = hover.x * zoom + px;
      const sy = (hover.y + hover.r) * zoom + py + 8;
      let bx = sx - wText / 2;
      bx = Math.max(8, Math.min(size.w - wText - 8, bx));
      const by = sy + 44 > size.h ? (hover.y - hover.r) * zoom + py - 52 : sy;
      ctx.fillStyle = "rgba(20,20,20,0.96)";
      ctx.beginPath();
      ctx.roundRect(bx, by, wText, 42, 4);
      ctx.fill();
      ctx.strokeStyle = "#2e2e2e";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#e6e6e6";
      ctx.fillText(caption, bx + 10, by + 8);
      ctx.fillStyle = "#7c7c7c";
      ctx.fillText(author, bx + 10, by + 24);
    }
  }, [size.w, size.h, selectedId, elements.length]);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  // Simulation loop: runs while the layout is still settling.
  const simRef = useRef(0);
  const runSim = useCallback(() => {
    if (simRef.current) return;
    const step = () => {
      simRef.current = 0;
      const g = graphRef.current;
      if (!g || !size.w) return;
      if (alphaRef.current > 0.012) {
        tick(g, size.w, size.h, alphaRef.current);
        alphaRef.current *= 0.975;
        draw();
        simRef.current = requestAnimationFrame(step);
      } else {
        draw();
      }
    };
    simRef.current = requestAnimationFrame(step);
  }, [draw, size.w, size.h]);

  useEffect(() => {
    if (!size.w || !size.h) return;
    graphRef.current = buildGraph(elements, size.w, size.h);
    viewRef.current = { x: 0, y: 0, zoom: 1 };
    alphaRef.current = 1;
    hoverRef.current = null;
    runSim();
    // Rebuild only when the element set changes or the canvas first gets a
    // size; later resizes keep the settled layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, size.w > 0, size.h > 0]);

  useEffect(() => {
    draw();
  }, [draw]);
  useEffect(() => subscribeArt(requestDraw), [requestDraw]);
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (simRef.current) cancelAnimationFrame(simRef.current);
    },
    [],
  );

  // Wheel zoom needs a non-passive listener to prevent page scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = viewRef.current;
      const zooming = !e.shiftKey && (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX));
      if (zooming) {
        const factor = Math.exp(-e.deltaY * 0.0022);
        const zoom = Math.min(5, Math.max(0.15, v.zoom * factor));
        const scale = zoom / v.zoom;
        viewRef.current = { zoom, x: mx - (mx - v.x) * scale, y: my - (my - v.y) * scale };
      } else {
        viewRef.current = { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      }
      requestDraw();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [requestDraw]);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - rect.left - v.x) / v.zoom, y: (e.clientY - rect.top - v.y) / v.zoom };
  };

  const nodeAt = (wx: number, wy: number): Node | null => {
    const g = graphRef.current;
    if (!g) return null;
    for (let i = g.nodes.length - 1; i >= 0; i--) {
      const nd = g.nodes[i];
      if (Math.abs(wx - nd.x) <= nd.r && Math.abs(wy - nd.y) <= nd.r) return nd;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toWorld(e);
    const nd = nodeAt(p.x, p.y);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (nd) {
      nd.pinned = true;
      dragRef.current = { mode: "node", node: nd, sx: e.clientX, sy: e.clientY, ox: nd.x, oy: nd.y, moved: false };
    } else {
      dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y, moved: false };
      setDragging(true);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d) {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.hypot(dx, dy) > 3) d.moved = true;
      if (d.mode === "pan") {
        viewRef.current = { ...viewRef.current, x: d.ox + dx, y: d.oy + dy };
      } else if (d.node) {
        const z = viewRef.current.zoom;
        d.node.x = d.ox + dx / z;
        d.node.y = d.oy + dy / z;
        d.node.vx = 0;
        d.node.vy = 0;
        if (d.moved) {
          alphaRef.current = Math.max(alphaRef.current, 0.12);
          runSim();
        }
      }
      requestDraw();
      return;
    }
    const p = toWorld(e);
    const nd = nodeAt(p.x, p.y);
    if (nd !== hoverRef.current) {
      hoverRef.current = nd;
      if (canvasRef.current) canvasRef.current.style.cursor = nd ? "pointer" : "";
      requestDraw();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d) return;
    if (d.mode === "node" && d.node) {
      d.node.pinned = false;
      if (!d.moved) {
        const id = d.node.el.id;
        onSelect(id === selectedId && e.detail === 1 ? null : id);
        if (e.detail >= 2) onOpen(d.node.el);
      }
    } else if (!d.moved && e.detail === 1) {
      onSelect(null);
    }
    requestDraw();
  };

  const reveal = useCallback(
    (id: string) => {
      const nd = graphRef.current?.byId.get(id);
      if (!nd) return;
      const v = viewRef.current;
      viewRef.current = { ...v, x: size.w / 2 - nd.x * v.zoom, y: size.h / 2 - nd.y * v.zoom };
      requestDraw();
    },
    [requestDraw, size.w, size.h],
  );

  useEffect(() => {
    apiRef.current = {
      navigate(dir) {
        const g = graphRef.current;
        if (!g || !g.nodes.length) return;
        const current = selectedId ? g.byId.get(selectedId) : null;
        if (!current) {
          onSelect(g.nodes[0].el.id);
          reveal(g.nodes[0].el.id);
          return;
        }
        // Nearest node in the requested direction (cone search).
        const dirs: Record<NavDir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
        const [dx, dy] = dirs[dir];
        let best: Node | null = null;
        let bestScore = Infinity;
        for (const nd of g.nodes) {
          if (nd === current) continue;
          const vx = nd.x - current.x;
          const vy = nd.y - current.y;
          const dist = Math.hypot(vx, vy);
          const along = (vx * dx + vy * dy) / dist;
          if (along < 0.5) continue;
          const score = dist / along;
          if (score < bestScore) {
            bestScore = score;
            best = nd;
          }
        }
        if (best) {
          onSelect(best.el.id);
          reveal(best.el.id);
        }
      },
      reveal,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, onSelect, reveal, selectedId]);

  return (
    <div ref={wrapRef} className="grid-scroller" style={{ overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        className={`graph-canvas${dragging ? " dragging" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          if (hoverRef.current) {
            hoverRef.current = null;
            requestDraw();
          }
        }}
        role="img"
        aria-label="Graph of elements connected by author and tags"
      />
      {elements.length === 0 && <div className="main-empty">{emptyMessage ?? "No elements match."}</div>}
    </div>
  );
}
