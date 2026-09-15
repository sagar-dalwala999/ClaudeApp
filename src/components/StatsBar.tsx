"use client";

import { formatBytes, groupThousands, plural } from "@/lib/format";
import type { ItemType } from "@/lib/vocab";
import { ITEM_TYPES, TYPE_LABELS } from "@/lib/vocab";

export type ViewMode = "grid" | "graph";

export interface LibraryCounts {
  items: number;
  ready: number;
  pending: number;
  failed: number;
  unread: number;
  enriched: number;
  mediaBytes: number;
  mediaCount: number;
  addedToday: number;
  addedThisWeek: number;
}

interface Props {
  counts: LibraryCounts;
  shown: number;
  total: number;
  view: ViewMode;
  onView(view: ViewMode): void;
  typeFilter: ItemType | "all";
  onTypeFilter(type: ItemType | "all"): void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
}

export function StatsBar({
  counts,
  shown,
  total,
  view,
  onView,
  typeFilter,
  onTypeFilter,
  hasMore,
  loadingMore,
  onLoadMore,
}: Props) {
  const inFlight = counts.pending;
  return (
    <>
      <div className="stats-left">
        <span>
          <b>{groupThousands(counts.items)}</b> links
        </span>
        <span>
          <b>{groupThousands(counts.mediaCount)}</b> media
        </span>
        <span>
          <b>{formatBytes(counts.mediaBytes)}</b>
        </span>
        <span className={counts.failed ? "warn" : undefined}>
          <b>{groupThousands(counts.addedToday)}</b> today
        </span>
      </div>
      <div className="stats-right">
        <span>
          {inFlight > 0 && (
            <>
              <b className="pulse">{groupThousands(inFlight)}</b> fetching ·{" "}
            </>
          )}
          {shown !== total ? (
            <>
              <b>{groupThousands(shown)}</b> of <b>{groupThousands(total)}</b> {plural(total, "link", "links")}
            </>
          ) : (
            <>
              <b>{groupThousands(total)}</b> {plural(total, "link", "links")}
            </>
          )}
          {hasMore && (
            <button type="button" className="hint inline" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? "loading…" : "load more"}
            </button>
          )}
        </span>
        <span className="type-filter" role="radiogroup" aria-label="Filter by type">
          <button
            type="button"
            role="radio"
            aria-checked={typeFilter === "all"}
            className={typeFilter === "all" ? "active" : ""}
            onClick={() => onTypeFilter("all")}
          >
            all
          </button>
          {ITEM_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={typeFilter === type}
              className={typeFilter === type ? "active" : ""}
              onClick={() => onTypeFilter(type)}
            >
              {TYPE_LABELS[type]}
            </button>
          ))}
        </span>
        <span className="view-toggle" role="radiogroup" aria-label="View">
          View:
          <button
            type="button"
            role="radio"
            aria-checked={view === "grid"}
            className={view === "grid" ? "active" : ""}
            onClick={() => onView("grid")}
          >
            Grid
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view === "graph"}
            className={view === "graph" ? "active" : ""}
            onClick={() => onView("graph")}
          >
            Graph
          </button>
        </span>
        <span className="spacer" />
      </div>
    </>
  );
}
