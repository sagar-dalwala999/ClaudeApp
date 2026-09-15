"use client";

/**
 * The archive.
 *
 * Owns the state the canvas views render: which collection is open, which item
 * is selected, what is being filtered, and the live updates arriving from the
 * worker over server-sent events.
 *
 * Server components hand it the first page, so the wall is painted on the
 * first frame rather than after a round trip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ClientCollection, ClientItem, ItemLike } from "@/lib/item";
import { toClientItem } from "@/lib/item";
import { resetSettings, updateSettings, useSettings } from "@/lib/settings";
import type { ItemType } from "@/lib/vocab";
import { CaptureBar, type CaptureOutcome } from "./CaptureBar";
import { GraphCanvas, type GraphApi } from "./GraphCanvas";
import { GridCanvas, type GridApi } from "./GridCanvas";
import { ItemDetail } from "./ItemDetail";
import { SearchPalette } from "./SearchPalette";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { StatsBar, type LibraryCounts, type ViewMode } from "./StatsBar";
import { StatusBar, type StatusAction } from "./StatusBar";
import { TopBar } from "./TopBar";

export interface ArchiveProps {
  initialItems: ClientItem[];
  initialCursor: string | null;
  initialCollections: ClientCollection[];
  initialPreviews: Record<string, ClientItem[]>;
  initialRecent: ClientItem[];
  counts: LibraryCounts;
  defaultCollectionId: string;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

function mergeLiveItems(current: ClientItem[], incoming: ClientItem[]): ClientItem[] {
  const next = [...current];
  let changed = false;
  for (const item of incoming) {
    const index = next.findIndex((existing) => existing.id === item.id);
    if (index === -1) {
      next.unshift(item);
      changed = true;
    } else if (item.updatedAt > next[index].updatedAt) {
      next[index] = item;
      changed = true;
    }
  }
  return changed ? next : current;
}

export function Archive({
  initialItems,
  initialCursor,
  initialCollections,
  initialPreviews,
  initialRecent,
  counts: initialCounts,
  defaultCollectionId,
}: ArchiveProps) {
  const [items, setItems] = useState<ClientItem[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [collections, setCollections] = useState<ClientCollection[]>(initialCollections);
  const [previews, setPreviews] = useState<Record<string, ClientItem[]>>(initialPreviews);
  const [recent, setRecent] = useState<ClientItem[]>(initialRecent);
  const [counts, setCounts] = useState<LibraryCounts>(initialCounts);

  const [activeId, setActiveId] = useState(defaultCollectionId);
  const [typeFilter, setTypeFilter] = useState<ItemType | "all">("all");
  const [filter, setFilter] = useState("");
  const [find, setFind] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [captureOutcome, setCaptureOutcome] = useState<CaptureOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const settings = useSettings();
  const findRef = useRef<HTMLInputElement>(null);
  const gridApi = useRef<GridApi | null>(null);
  const graphApi = useRef<GraphApi | null>(null);
  const loadSeq = useRef(0);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  /* ------------------------------------------------------------- loading */

  const load = useCallback(
    async (collectionId: string, type: ItemType | "all") => {
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        const result = await api.listItems({
          collectionId: collectionId === "everything" ? null : collectionId,
          limit: 120,
          type: type === "all" ? null : type,
        });
        if (seq !== loadSeq.current) return;
        setItems(result.items.map(toClientItem));
        setCursor(result.nextCursor);
        setSelectedId(null);
      } catch (err) {
        if (seq === loadSeq.current) setNotice(err instanceof ApiError ? err.message : "Could not load that collection");
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [],
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.listItems({
        collectionId: activeId === "everything" ? null : activeId,
        type: typeFilter === "all" ? null : typeFilter,
        cursor,
        limit: 120,
      });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...result.items.map(toClientItem).filter((item) => !seen.has(item.id))];
      });
      setCursor(result.nextCursor);
    } catch {
      setNotice("Could not load more");
    } finally {
      setLoadingMore(false);
    }
  }, [activeId, cursor, loadingMore, typeFilter]);

  const refreshSidebar = useCallback(async () => {
    try {
      const result = await api.listCollections();
      setCollections(result.collections);
      setPreviews(Object.fromEntries(Object.entries(result.previews).map(([id, list]) => [id, list.map(toClientItem)])));
      setRecent(result.recent.map(toClientItem));
    } catch {
      /* sidebar staleness is not worth an error banner */
    }
  }, []);

  const refreshCounts = useCallback(async () => {
    try {
      const { stats } = await api.system();
      setCounts(stats);
    } catch {
      /* ignore */
    }
  }, []);

  const reconcileLiveItems = useCallback(async () => {
    try {
      const result = await api.listItems({
        collectionId: activeId === "everything" ? null : activeId,
        type: typeFilter === "all" ? null : typeFilter,
        limit: 120,
      });
      const incoming = result.items.map(toClientItem);
      setItems((current) => mergeLiveItems(current, incoming));
      setRecent((current) => mergeLiveItems(current, incoming).slice(0, 12));
    } catch {
      /* the event stream will retry; keep the current wall intact */
    }
  }, [activeId, typeFilter]);

  // The server component already painted the first page; only reload when the
  // collection or type filter actually changes.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    void load(activeId, typeFilter);
  }, [activeId, typeFilter, load]);

  /* -------------------------------------------------------- live updates */

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      source = new EventSource("/api/events");
      source.addEventListener("hello", () => {
        // Reconcile the SSR snapshot and every reconnect. An enrichment can
        // finish before the stream starts or while the browser is offline.
        void reconcileLiveItems();
      });
      source.addEventListener("items", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { items: ItemLike[] };
          const incoming = payload.items.map(toClientItem);
          setItems((current) => mergeLiveItems(current, incoming));
          setRecent((current) => mergeLiveItems(current, incoming).slice(0, 12));
        } catch {
          /* malformed frame: ignore and keep the stream */
        }
      });
      source.addEventListener("error", () => {
        source?.close();
        source = null;
        if (!stopped) window.setTimeout(connect, 4000);
      });
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
    };
  }, [reconcileLiveItems]);

  // Counts are cheap and drift as the worker finishes items.
  useEffect(() => {
    const timer = setInterval(() => void refreshCounts(), 20_000);
    return () => clearInterval(timer);
  }, [refreshCounts]);

  /* ------------------------------------------------------------ commands */

  const selectCollection = useCallback((id: string) => {
    setActiveId(id);
    setFilter("");
    setOpenId(null);
    setSelectedId(null);
  }, []);

  const visibleCollections = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? collections.filter((collection) => collection.name.toLowerCase().includes(query)) : collections;
  }, [collections, filter]);

  const switchCollection = useCallback(
    (delta: number) => {
      const list = visibleCollections;
      if (!list.length) return;
      const index = list.findIndex((collection) => collection.id === activeId);
      const next = list[(index + delta + list.length) % list.length];
      selectCollection(next.id);
    },
    [visibleCollections, activeId, selectCollection],
  );

  // Text filter within the open collection, applied client-side so typing is instant.
  const shown = useMemo(() => {
    const query = find.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(query) ||
        (item.summary ?? "").toLowerCase().includes(query) ||
        (item.note ?? "").toLowerCase().includes(query) ||
        item.author.toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.includes(query)),
    );
  }, [items, find]);

  const openItem = useCallback((item: ClientItem) => {
    setSelectedId(item.id);
    setOpenId(item.id);
  }, []);

  const stepOpen = useCallback(
    (delta: number) => {
      if (!openId || !shown.length) return;
      const index = shown.findIndex((item) => item.id === openId);
      const next = shown[(index + delta + shown.length) % shown.length];
      setOpenId(next.id);
      setSelectedId(next.id);
      (view === "grid" ? gridApi.current : graphApi.current)?.reveal(next.id);
    },
    [openId, shown, view],
  );

  const openBySearch = useCallback(
    (item: ClientItem) => {
      setItems((current) => (current.some((existing) => existing.id === item.id) ? current : [item, ...current]));
      setSelectedId(item.id);
      setOpenId(item.id);
    },
    [],
  );

  const createCollection = useCallback(
    async (name: string) => {
      setCreating(false);
      try {
        const { collection } = await api.createCollection(name);
        await refreshSidebar();
        selectCollection(collection.id);
      } catch (err) {
        setNotice(err instanceof ApiError ? err.message : "Could not create that collection");
      }
    },
    [refreshSidebar, selectCollection],
  );

  const deleteCollection = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this collection? The links inside are kept.")) return;
      try {
        await api.deleteCollection(id);
        await refreshSidebar();
        if (activeId === id) selectCollection("everything");
      } catch (err) {
        setNotice(err instanceof ApiError ? err.message : "Could not delete that collection");
      }
    },
    [activeId, refreshSidebar, selectCollection],
  );

  const focusFind = useCallback(() => {
    const input = findRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const onAction = useCallback(
    (action: StatusAction) => {
      switch (action) {
        case "toggleSidebar":
          setSidebarHidden((value) => !value);
          break;
        case "newCollection":
          setSidebarHidden(false);
          setCreating(true);
          break;
        case "prevCollection":
          switchCollection(-1);
          break;
        case "nextCollection":
          switchCollection(1);
          break;
        case "navigate":
          (view === "grid" ? gridApi.current : graphApi.current)?.navigate("down");
          break;
        case "find":
          focusFind();
          break;
        case "settings":
          setSettingsOpen((value) => !value);
          break;
        case "search":
          setSearchOpen(true);
          break;
        case "capture":
          setCaptureOpen(true);
          break;
        case "retry":
          void load(activeId, typeFilter);
          break;
      }
    },
    [activeId, typeFilter, focusFind, load, switchCollection, view],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key;
      const lower = key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;
      const editable = isEditable(event.target);

      if (mod && lower === "k") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && lower === "v" && !editable) {
        event.preventDefault();
        setCaptureOpen(true);
        return;
      }
      if (openId) {
        if (key === "Escape") {
          event.preventDefault();
          setOpenId(null);
        } else if (!editable && (key === "ArrowLeft" || key === "ArrowUp")) {
          event.preventDefault();
          stepOpen(-1);
        } else if (!editable && (key === "ArrowRight" || key === "ArrowDown")) {
          event.preventDefault();
          stepOpen(1);
        }
        return;
      }
      if (key === "Escape") {
        if (searchOpen) setSearchOpen(false);
        else if (captureOpen) setCaptureOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (creating) setCreating(false);
        else if (editable && event.target === findRef.current) {
          if (find) setFind("");
          else findRef.current?.blur();
        } else if (editable) (event.target as HTMLElement).blur();
        else setSelectedId(null);
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && lower === "s") {
        event.preventDefault();
        setSidebarHidden((value) => !value);
        return;
      }
      if (mod && event.shiftKey && lower === "n") {
        event.preventDefault();
        setSidebarHidden(false);
        setCreating(true);
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && lower === "f") {
        event.preventDefault();
        focusFind();
        return;
      }
      if (mod && key === ",") {
        event.preventDefault();
        setSettingsOpen((value) => !value);
        return;
      }
      if (event.altKey && event.shiftKey && key.startsWith("Arrow")) {
        event.preventDefault();
        switchCollection(key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (editable || mod || event.altKey) return;

      if (key.startsWith("Arrow")) {
        event.preventDefault();
        const dir = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : "right";
        (view === "grid" ? gridApi.current : graphApi.current)?.navigate(dir);
        return;
      }
      if ((key === "Enter" || key === " ") && selectedId) {
        event.preventDefault();
        const item = byId.get(selectedId);
        if (item) setOpenId(item.id);
        return;
      }
      if (lower === "g" && !event.shiftKey) {
        setView((value) => (value === "grid" ? "graph" : "grid"));
      }
      if (lower === "s" && !event.shiftKey) {
        setView("grid");
      }
      if (lower === "f" && !event.shiftKey) {
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    byId,
    captureOpen,
    creating,
    find,
    focusFind,
    openId,
    searchOpen,
    selectedId,
    settingsOpen,
    stepOpen,
    switchCollection,
    view,
  ]);

  const activeName = activeId === "everything" ? "Everything" : (collections.find((c) => c.id === activeId)?.name ?? "Everything");
  const emptyMessage = find.trim()
    ? "No links match that filter."
    : loading
      ? "Loading…"
      : "Nothing here yet. Press ⌘V and paste a link.";

  const openItemValue = openId ? byId.get(openId) : null;
  const openIndex = openItemValue ? shown.findIndex((item) => item.id === openItemValue.id) : -1;

  return (
    <div className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <TopBar
        sidebarHidden={sidebarHidden}
        onToggleSidebar={() => setSidebarHidden((value) => !value)}
        filter={filter}
        onFilter={setFilter}
        title={activeName}
        find={find}
        onFind={setFind}
        findRef={findRef}
      />
      <StatsBar
        counts={counts}
        shown={shown.length}
        total={items.length}
        view={view}
        onView={setView}
        typeFilter={typeFilter}
        onTypeFilter={setTypeFilter}
        hasMore={Boolean(cursor)}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
      />
      <Sidebar
        collections={visibleCollections}
        previews={previews}
        recent={recent}
        totalCount={counts.items}
        activeId={activeId}
        onSelect={selectCollection}
        creating={creating}
        onCreate={(name) => void createCollection(name)}
        onCancelCreate={() => setCreating(false)}
        onDelete={(id) => void deleteCollection(id)}
      />
      <main className="main">
        {view === "grid" ? (
          <GridCanvas
            elements={shown}
            settings={settings}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={openItem}
            apiRef={gridApi}
            emptyMessage={emptyMessage}
          />
        ) : (
          <GraphCanvas
            elements={shown}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={openItem}
            apiRef={graphApi}
            emptyMessage={emptyMessage}
          />
        )}
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            onChange={updateSettings}
            onReset={resetSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button type="button" className="hint" onClick={() => setNotice(null)}>
              dismiss
            </button>
          </div>
        )}
      </main>
      <StatusBar sidebarHidden={sidebarHidden} onAction={onAction} />
      {captureOpen && (
        <CaptureBar
          open={captureOpen}
          collectionId={activeId === "everything" ? null : activeId}
          outcome={captureOutcome}
          onOutcome={setCaptureOutcome}
          onClose={() => {
            setCaptureOpen(false);
            setCaptureOutcome(null);
          }}
          onSaved={() => {
            void refreshCounts();
            void refreshSidebar();
          }}
        />
      )}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} onOpenItem={openBySearch} />}
      {openItemValue && (
        <ItemDetail
          key={openItemValue.id}
          item={openItemValue}
          position={`${openIndex + 1} / ${shown.length}`}
          onClose={() => setOpenId(null)}
          onPrev={() => stepOpen(-1)}
          onNext={() => stepOpen(1)}
          onChanged={(updated) => {
            setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
            setRecent((current) => current.map((item) => (item.id === updated.id ? updated : item)));
          }}
          onDeleted={(id) => {
            setItems((current) => current.filter((item) => item.id !== id));
            setRecent((current) => current.filter((item) => item.id !== id));
            setOpenId(null);
            void refreshCounts();
            void refreshSidebar();
          }}
        />
      )}
    </div>
  );
}
