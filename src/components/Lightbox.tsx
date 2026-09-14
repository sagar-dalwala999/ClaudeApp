"use client";

import { useEffect, useRef } from "react";
import type { Library, LooksElement } from "@/lib/data";
import { renderArt } from "@/lib/art";
import { formatBytes } from "@/lib/format";

interface Props {
  el: LooksElement;
  library: Library;
  position: string;
  onClose(): void;
  onPrev(): void;
  onNext(): void;
}

const LIGHTBOX_W = 720;

/** Deterministic "added" date derived from the element index. */
function addedDate(el: LooksElement): string {
  const base = Date.UTC(2024, 0, 3);
  const t = base + el.index * 1.26 * 86400e3 + (el.seed % 20) * 3600e3;
  return new Date(t).toISOString().slice(0, 10);
}

export function Lightbox({ el, library, position, onClose, onPrev, onNext }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || el.kind === "text") return;
    const art = renderArt(el, LIGHTBOX_W);
    canvas.width = art.width;
    canvas.height = art.height;
    canvas.style.aspectRatio = `${art.width} / ${art.height}`;
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(art, 0, 0);
  }, [el]);

  const collections = el.collections
    .map((id) => library.collections.find((c) => c.id === id)?.name)
    .filter((n): n is string => Boolean(n));

  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={el.caption}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="media">
          {el.kind === "text" ? (
            <p style={{ padding: 40, fontSize: 15, lineHeight: 1.6, color: "#ececec", maxWidth: 520, margin: 0 }}>{el.caption}</p>
          ) : (
            <canvas ref={canvasRef} aria-hidden="true" />
          )}
        </div>
        <aside className="meta">
          <p>{el.caption}</p>
          <dl>
            <dt>by</dt>
            <dd>@{el.author}</dd>
            <dt>kind</dt>
            <dd>{el.kind}</dd>
            <dt>look</dt>
            <dd>{el.style}</dd>
            <dt>files</dt>
            <dd>{el.mediaFiles ? `${el.mediaFiles} media + note` : "note"}</dd>
            <dt>size</dt>
            <dd>{formatBytes(el.bytes)}</dd>
            <dt>added</dt>
            <dd>{addedDate(el)}</dd>
            <dt>tags</dt>
            <dd className="tags">
              {el.tags.map((t) => (
                <span key={t}>#{t}</span>
              ))}
            </dd>
            <dt>in</dt>
            <dd className="collections">{collections.length ? collections.map((c) => <span key={c}>{c}</span>) : <span>—</span>}</dd>
          </dl>
          <div className="actions">
            <button type="button" className="hint" onClick={onPrev} aria-label="Previous element">
              <kbd>←</kbd>
            </button>
            <span>{position}</span>
            <button type="button" className="hint" onClick={onNext} aria-label="Next element">
              <kbd>→</kbd>
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" className="hint" onClick={onClose}>
              <kbd>esc</kbd> close
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
