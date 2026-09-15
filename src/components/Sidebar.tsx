"use client";

import { useEffect, useRef, useState } from "react";
import type { ClientCollection, ClientItem } from "@/lib/item";
import { SidebarStrip } from "./SidebarStrip";

interface Props {
  collections: ClientCollection[];
  /** Up to a dozen items per collection id, for the canvas thumbnail strips. */
  previews: Record<string, ClientItem[]>;
  /** Strip for the virtual "Everything" row. */
  recent: ClientItem[];
  totalCount: number;
  activeId: string;
  onSelect(id: string): void;
  creating: boolean;
  onCreate(name: string): void;
  onCancelCreate(): void;
  onDelete(id: string): void;
}

export function Sidebar({
  collections,
  previews,
  recent,
  totalCount,
  activeId,
  onSelect,
  creating,
  onCreate,
  onCancelCreate,
  onDelete,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active row in view when switching with the keyboard.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(activeId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <nav ref={listRef} className="sidebar" aria-label="Collections">
      <CollectionRow
        id="everything"
        name="Everything"
        count={totalCount}
        active={activeId === "everything"}
        onSelect={() => onSelect("everything")}
        preview={recent}
      />
      {creating && <NewCollectionRow onCreate={onCreate} onCancel={onCancelCreate} />}
      {collections.map((collection) => (
        <CollectionRow
          key={collection.id}
          id={collection.id}
          name={collection.name}
          count={collection.count}
          active={collection.id === activeId}
          onSelect={() => onSelect(collection.id)}
          onDelete={() => onDelete(collection.id)}
          preview={previews[collection.id] ?? []}
        />
      ))}
      {!collections.length && !creating && (
        <div className="sidebar-empty">No collections yet. Press ⇧⌘N to make one.</div>
      )}
    </nav>
  );
}

function CollectionRow({
  id,
  name,
  count,
  active,
  onSelect,
  onDelete,
  preview,
}: {
  id: string;
  name: string;
  count: number;
  active: boolean;
  onSelect(): void;
  onDelete?(): void;
  preview: ClientItem[];
}) {
  return (
    <div
      className={`collection-row${active ? " active" : ""}`}
      data-id={id}
      role="button"
      tabIndex={0}
      aria-current={active}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="row-head">
        <span className="name" title={name}>
          {name}
        </span>
        <span className="count">{count}</span>
        {onDelete && !active && (
          <button
            type="button"
            className="row-delete"
            aria-label={`Delete collection ${name}`}
            title="Delete collection (items are kept)"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            ×
          </button>
        )}
      </div>
      <SidebarStrip elements={preview} />
    </div>
  );
}

function NewCollectionRow({ onCreate, onCancel }: { onCreate(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="collection-row editing">
      <div className="row-head">
        <input
          ref={inputRef}
          value={value}
          placeholder="Collection name"
          aria-label="New collection name"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onCreate(value.trim());
            if (e.key === "Escape") onCancel();
          }}
          onBlur={() => {
            if (!value.trim()) onCancel();
          }}
        />
      </div>
    </div>
  );
}
