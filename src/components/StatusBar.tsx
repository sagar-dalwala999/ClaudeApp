"use client";

export type StatusAction =
  | "toggleSidebar"
  | "newCollection"
  | "prevCollection"
  | "nextCollection"
  | "navigate"
  | "find"
  | "settings"
  | "search"
  | "capture"
  | "retry";

interface Props {
  sidebarHidden: boolean;
  onAction(action: StatusAction): void;
}

export function StatusBar({ sidebarHidden, onAction }: Props) {
  return (
    <footer className="status">
      <div className="group">
        <Hint keys={["⌘V"]} label="Save a link" onClick={() => onAction("capture")} primary />
        <Hint keys={["⌘K"]} label="Search" onClick={() => onAction("search")} primary />
        <Hint keys={["⌃S"]} label={sidebarHidden ? "Show Sidebar" : "Hide Sidebar"} onClick={() => onAction("toggleSidebar")} />
        <Hint keys={["⇧⌘N"]} label="New Collection" onClick={() => onAction("newCollection")} />
      </div>
      <div className="group">
        <Hint keys={["⌥⇧ ↕"]} label="Switch collection" onClick={() => onAction("nextCollection")} />
        <Hint keys={["↕ ↔"]} label="Navigate" onClick={() => onAction("navigate")} />
        <Hint keys={["⌘F"]} label="Filter" onClick={() => onAction("find")} />
        <Hint keys={["⌘,"]} label="Settings" onClick={() => onAction("settings")} />
      </div>
    </footer>
  );
}

function Hint({ keys, label, onClick, primary }: { keys: string[]; label: string; onClick(): void; primary?: boolean }) {
  return (
    <button type="button" className={`hint${primary ? " primary" : ""}`} onClick={onClick}>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
      <span>{label}</span>
    </button>
  );
}
