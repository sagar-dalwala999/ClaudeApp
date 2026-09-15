"use client";

import Link from "next/link";
import { LogoutForm } from "./LogoutLink";

interface Props {
  sidebarHidden: boolean;
  onToggleSidebar(): void;
  filter: string;
  onFilter(value: string): void;
  title: string;
  find: string;
  onFind(value: string): void;
  findRef: React.RefObject<HTMLInputElement | null>;
}

export function TopBar({ sidebarHidden, onToggleSidebar, filter, onFilter, title, find, onFind, findRef }: Props) {
  return (
    <>
      <div className="top-left">
        <div className="traffic" aria-hidden="true">
          <span className="close" />
          <span className="min" />
          <span className="max" />
        </div>
        <button
          type="button"
          className="tab active"
          onClick={onToggleSidebar}
          title={sidebarHidden ? "Show sidebar (⌃S)" : "Hide sidebar (⌃S)"}
        >
          Mine
        </button>
        <input
          className="filter"
          type="search"
          placeholder="Filter collections..."
          aria-label="Filter collections"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="top-right">
        <span className="title">{title}</span>
        <input
          ref={findRef}
          className="find"
          type="search"
          placeholder="Filter links"
          aria-label="Filter links in this collection"
          value={find}
          onChange={(e) => onFind(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <Link className="hint" href="/settings" title="Tokens, resolver health, export">
          system
        </Link>
        <LogoutForm />
      </div>
    </>
  );
}
