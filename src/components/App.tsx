"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EVERYTHING_ID, LIBRARY, elementsOf, type Collection, type LooksElement } from "@/lib/data";
import { hashString, mulberry32, shuffle } from "@/lib/random";
import { resetSettings, updateSettings, useSettings } from "@/lib/settings";
import { GraphCanvas, type GraphApi } from "./GraphCanvas";
import { GridCanvas, type GridApi } from "./GridCanvas";
import { Lightbox } from "./Lightbox";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { StatsBar, type ViewMode } from "./StatsBar";
import { StatusBar, type StatusAction } from "./StatusBar";
import { TopBar } from "./TopBar";

const INITIAL_COLLECTION = LIBRARY.collections.find((c) => c.name === "Интерфейсы")?.id ?? EVERYTHING_ID;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

export function App() {
  const [userCollections, setUserCollections] = useState<Collection[]>([]);
  const [activeId, setActiveId] = useState<string>(INITIAL_COLLECTION);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [find, setFind] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useSettings();
  const [creating, setCreating] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const gridApi = useRef<GridApi | null>(null);
  const graphApi = useRef<GraphApi | null>(null);

  const library = useMemo(
    () => ({ ...LIBRARY, collections: [...LIBRARY.collections, ...userCollections] }),
    [userCollections],
  );

  const visibleCollections = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? library.collections.filter((c) => c.name.toLowerCase().includes(q)) : library.collections;
  }, [library, filter]);

  const active = library.collections.find((c) => c.id === activeId) ?? library.collections[0];

  const baseElements = useMemo(() => elementsOf(library, active), [library, active]);

  const elements = useMemo(() => {
    const q = find.trim().toLowerCase();
    let list = q
      ? baseElements.filter(
          (e) => e.caption.toLowerCase().includes(q) || e.author.toLowerCase().includes(q) || e.tags.some((t) => t.includes(q)),
        )
      : baseElements;
    if (settings.sort === "author") list = [...list].sort((a, b) => a.author.localeCompare(b.author) || a.index - b.index);
    else if (settings.sort === "random") list = shuffle(mulberry32(hashString(active.id)), list);
    return list;
  }, [baseElements, find, settings.sort, active.id]);

  const selectCollection = useCallback((id: string) => {
    setActiveId(id);
    setSelectedId(null);
    setOpenId(null);
  }, []);

  const switchCollection = useCallback(
    (delta: number) => {
      const list = visibleCollections;
      if (!list.length) return;
      const i = list.findIndex((c) => c.id === activeId);
      const next = list[(i + delta + list.length) % list.length];
      selectCollection(next.id);
    },
    [visibleCollections, activeId, selectCollection],
  );

  const openElement = useCallback((el: LooksElement) => {
    setSelectedId(el.id);
    setOpenId(el.id);
  }, []);

  const stepOpen = useCallback(
    (delta: number) => {
      if (!openId || !elements.length) return;
      const i = elements.findIndex((e) => e.id === openId);
      const next = elements[(i + delta + elements.length) % elements.length];
      setOpenId(next.id);
      setSelectedId(next.id);
      (view === "grid" ? gridApi.current : graphApi.current)?.reveal(next.id);
    },
    [openId, elements, view],
  );

  const createCollection = useCallback((name: string) => {
    const id = `user-${Date.now().toString(36)}`;
    setUserCollections((list) => [...list, { id, name, elementIds: [] }]);
    setCreating(false);
    setFilter("");
    selectCollection(id);
  }, [selectCollection]);

  const focusFind = useCallback(() => {
    const input = findRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const onAction = useCallback(
    (a: StatusAction) => {
      switch (a) {
        case "toggleSidebar":
          setSidebarHidden((v) => !v);
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
          setSettingsOpen((v) => !v);
          break;
      }
    },
    [switchCollection, focusFind, view],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key;
      const lower = key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      const editable = isEditable(e.target);

      if (openId) {
        if (key === "Escape") {
          e.preventDefault();
          setOpenId(null);
        } else if (key === "ArrowLeft" || key === "ArrowUp") {
          e.preventDefault();
          stepOpen(-1);
        } else if (key === "ArrowRight" || key === "ArrowDown") {
          e.preventDefault();
          stepOpen(1);
        }
        return;
      }

      if (key === "Escape") {
        if (settingsOpen) setSettingsOpen(false);
        else if (creating) setCreating(false);
        else if (editable && e.target === findRef.current) {
          if (find) setFind("");
          else findRef.current?.blur();
        } else if (editable) (e.target as HTMLElement).blur();
        else setSelectedId(null);
        return;
      }

      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && lower === "s") {
        e.preventDefault();
        setSidebarHidden((v) => !v);
        return;
      }
      if (mod && e.shiftKey && lower === "n") {
        e.preventDefault();
        setSidebarHidden(false);
        setCreating(true);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && lower === "f") {
        e.preventDefault();
        focusFind();
        return;
      }
      if (mod && key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
        return;
      }
      if (e.altKey && e.shiftKey && key.startsWith("Arrow")) {
        e.preventDefault();
        switchCollection(key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (editable || mod || e.altKey) return;

      if (key.startsWith("Arrow")) {
        e.preventDefault();
        const dir = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : "right";
        (view === "grid" ? gridApi.current : graphApi.current)?.navigate(dir);
        return;
      }
      if ((key === "Enter" || key === " ") && selectedId) {
        e.preventDefault();
        const el = library.byId.get(selectedId);
        if (el) setOpenId(el.id);
        return;
      }
      if (lower === "g" && !e.shiftKey) {
        setView((v) => (v === "grid" ? "graph" : "grid"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, settingsOpen, creating, find, selectedId, view, library, stepOpen, focusFind, switchCollection]);

  const emptyMessage = baseElements.length || find.trim() ? "No elements match." : "Empty collection. Drop files here to start it.";
  const openEl = openId ? (library.byId.get(openId) ?? null) : null;
  const openIndex = openEl ? elements.findIndex((e) => e.id === openEl.id) : -1;

  return (
    <div className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <TopBar
        sidebarHidden={sidebarHidden}
        onToggleSidebar={() => setSidebarHidden((v) => !v)}
        filter={filter}
        onFilter={setFilter}
        title={active.name}
        find={find}
        onFind={setFind}
        findRef={findRef}
      />
      <StatsBar stats={library.stats} shown={elements.length} total={baseElements.length} view={view} onView={setView} />
      <Sidebar
        library={library}
        collections={visibleCollections}
        activeId={active.id}
        onSelect={selectCollection}
        creating={creating}
        onCreate={createCollection}
        onCancelCreate={() => setCreating(false)}
      />
      <main className="main">
        {view === "grid" ? (
          <GridCanvas
            elements={elements}
            settings={settings}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={openElement}
            apiRef={gridApi}
            emptyMessage={emptyMessage}
          />
        ) : (
          <GraphCanvas
            elements={elements}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={openElement}
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
      </main>
      <StatusBar sidebarHidden={sidebarHidden} onAction={onAction} />
      {openEl && (
        <Lightbox
          el={openEl}
          library={library}
          position={`${openIndex + 1} / ${elements.length}`}
          onClose={() => setOpenId(null)}
          onPrev={() => stepOpen(-1)}
          onNext={() => stepOpen(1)}
        />
      )}
    </div>
  );
}
