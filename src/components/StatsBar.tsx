"use client";

import type { LibraryStats } from "@/lib/data";
import { formatBytes, groupThousands, plural } from "@/lib/format";

export type ViewMode = "grid" | "graph";

interface Props {
  stats: LibraryStats;
  shown: number;
  total: number;
  view: ViewMode;
  onView(view: ViewMode): void;
}

export function StatsBar({ stats, shown, total, view, onView }: Props) {
  return (
    <>
      <div className="stats-left">
        <span>
          <b>{groupThousands(stats.files)}</b> files
        </span>
        <span>
          <b>{groupThousands(stats.markdown)}</b> .md
        </span>
        <span>
          <b>{groupThousands(stats.media)}</b> media
        </span>
        <span>
          <b>{formatBytes(stats.bytes)}</b>
        </span>
      </div>
      <div className="stats-right">
        <span>
          {shown !== total ? (
            <>
              <b>{groupThousands(shown)}</b> of <b>{groupThousands(total)}</b> {plural(total, "element", "elements")} in collection
            </>
          ) : (
            <>
              <b>{groupThousands(total)}</b> {plural(total, "element", "elements")} in collection
            </>
          )}
        </span>
        <span className="view-toggle" role="radiogroup" aria-label="View">
          View:
          <button type="button" role="radio" aria-checked={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => onView("grid")}>
            Grid
          </button>
          <button type="button" role="radio" aria-checked={view === "graph"} className={view === "graph" ? "active" : ""} onClick={() => onView("graph")}>
            Graph
          </button>
        </span>
        <span className="spacer" />
      </div>
    </>
  );
}
