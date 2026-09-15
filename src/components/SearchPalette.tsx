"use client";

/**
 * ⌘K palette.
 *
 * Searches the whole archive — keyword and meaning at once — and jumps
 * straight to an item. The mode line says which half answered, so it is
 * obvious when semantic search is unavailable (no embedding key).
 *
 * Mounted only while open (the parent renders it conditionally), so every
 * open starts from an empty query without any state-reset effects. Results are
 * stored together with the query that produced them and read back through
 * `items`/`mode`, which keeps the effect free of synchronous state updates and
 * makes stale responses impossible to display.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ClientItem } from "@/lib/item";
import { toClientItem, relativeDay } from "@/lib/item";

interface Props {
  onClose(): void;
  onOpenItem(item: ClientItem): void;
}

interface SearchResult {
  query: string;
  items: ClientItem[];
  mode: string;
}

/** Below this many characters a search would match almost everything. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;

export function SearchPalette({ onClose, onOpenItem }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  const text = query.trim();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (text.length < MIN_QUERY) return;
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      api
        .search(text, 30)
        .then((response) => {
          if (id !== requestId.current) return;
          setResult({ query: text, items: response.items.map(toClientItem), mode: response.mode });
        })
        .catch(() => {
          if (id === requestId.current) setResult({ query: text, items: [], mode: "" });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Only show results that belong to the query on screen; anything older is a
  // response that is still in flight.
  const settled = result?.query === text ? result : null;
  const items = settled?.items ?? [];
  const mode = settled?.mode ?? "";
  const pending = text.length >= MIN_QUERY && !settled;
  const active = Math.min(cursor, Math.max(0, items.length - 1));

  const label = useMemo(() => {
    if (pending) return "searching…";
    if (!text) return "type to search titles, summaries, notes, tags and page text";
    if (!items.length) return "no matches";
    return `${items.length} ${items.length === 1 ? "match" : "matches"} · ${mode === "hybrid" ? "keyword + meaning" : "keyword"}`;
  }, [items.length, mode, pending, text]);

  return (
    <div className="overlay palette-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Search">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search the archive"
            aria-label="Search query"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor(Math.min(active + 1, Math.max(0, items.length - 1)));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor(Math.max(0, active - 1));
              }
              if (e.key === "Enter" && items[active]) {
                e.preventDefault();
                onOpenItem(items[active]);
                onClose();
              }
            }}
          />
          <span className="palette-mode">{label}</span>
        </div>
        {items.length > 0 && (
          <ul className="palette-list">
            {items.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={index === active ? "active" : ""}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => {
                    onOpenItem(item);
                    onClose();
                  }}
                >
                  <span className="palette-title">{item.title}</span>
                  <span className="palette-meta">
                    {item.host} · {item.type} · {relativeDay(item.addedAt)}
                    {item.tags.length ? ` · #${item.tags.slice(0, 2).join(" #")}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
