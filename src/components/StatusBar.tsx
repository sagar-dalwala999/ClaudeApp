"use client";

export type StatusAction = "toggleSidebar" | "newCollection" | "prevCollection" | "nextCollection" | "navigate" | "find" | "settings";

interface Props {
  sidebarHidden: boolean;
  onAction(action: StatusAction): void;
}

export function StatusBar({ sidebarHidden, onAction }: Props) {
  return (
    <footer className="status">
      <div className="group">
        <Hint keys={["⌃S"]} label={sidebarHidden ? "Show Sidebar" : "Hide Sidebar"} onClick={() => onAction("toggleSidebar")} />
        <Hint keys={["⇧⌘N"]} label="New Collection" onClick={() => onAction("newCollection")} />
        <Hint keys={["⌥⇧ ↕"]} label="Switch collection" onClick={() => onAction("nextCollection")} />
        <Hint keys={["↕ ↔"]} label="Navigate" onClick={() => onAction("navigate")} />
      </div>
      <div className="group">
        <Hint keys={["⌘F"]} label="Find elements" onClick={() => onAction("find")} />
        <Hint keys={["⌘,"]} label="Settings" onClick={() => onAction("settings")} />
      </div>
    </footer>
  );
}

function Hint({ keys, label, onClick }: { keys: string[]; label: string; onClick(): void }) {
  return (
    <button type="button" className="hint" onClick={onClick}>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
      <span>{label}</span>
    </button>
  );
}
