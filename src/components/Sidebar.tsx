"use client";

import { useEffect, useRef, useState } from "react";
import { elementsOf, type Collection, type Library } from "@/lib/data";
import { SidebarStrip } from "./SidebarStrip";

interface Props {
  library: Library;
  collections: Collection[];
  activeId: string;
  onSelect(id: string): void;
  creating: boolean;
  onCreate(name: string): void;
  onCancelCreate(): void;
}

export function Sidebar({ library, collections, activeId, onSelect, creating, onCreate, onCancelCreate }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active row in view when switching via keyboard.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(activeId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <nav ref={listRef} className="sidebar" aria-label="Collections">
      {collections.map((c, i) => (
        <div key={c.id}>
          <CollectionRow
            collection={c}
            library={library}
            active={c.id === activeId}
            onSelect={() => onSelect(c.id)}
          />
          {creating && i === 0 && <NewCollectionRow onCreate={onCreate} onCancel={onCancelCreate} />}
        </div>
      ))}
      {creating && collections.length === 0 && <NewCollectionRow onCreate={onCreate} onCancel={onCancelCreate} />}
      {collections.length === 0 && !creating && <div className="sidebar-empty">No collections match.</div>}
    </nav>
  );
}

function CollectionRow({
  collection,
  library,
  active,
  onSelect,
}: {
  collection: Collection;
  library: Library;
  active: boolean;
  onSelect(): void;
}) {
  const preview = elementsOf(library, collection).slice(0, 12);
  return (
    <div
      className={`collection-row${active ? " active" : ""}`}
      data-id={collection.id}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      title={collection.name}
    >
      <span className="name">{collection.name}</span>
      <SidebarStrip elements={preview} />
      <span className="count">{collection.elementIds.length}</span>
    </div>
  );
}

function NewCollectionRow({ onCreate, onCancel }: { onCreate(name: string): void; onCancel(): void }) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
    else onCancel();
  };
  return (
    <div className="collection-row editing active">
      <span className="name">
        <input
          ref={inputRef}
          value={name}
          placeholder="New collection"
          aria-label="New collection name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") onCancel();
            e.stopPropagation();
          }}
        />
      </span>
      <span />
      <span className="count">0</span>
    </div>
  );
}
