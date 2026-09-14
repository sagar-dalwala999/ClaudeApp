"use client";

import { useEffect, useRef } from "react";
import type { Settings, SortMode } from "@/lib/settings";

interface Props {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onReset(): void;
  onClose(): void;
}

export function SettingsPanel({ settings, onChange, onReset, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div ref={ref} className="settings" role="dialog" aria-label="Settings">
      <h2>
        Settings
        <button type="button" onClick={onClose} aria-label="Close settings">
          esc
        </button>
      </h2>
      <label>
        Card width
        <span className="row">
          <input
            type="range"
            min={140}
            max={360}
            step={4}
            value={settings.colW}
            onChange={(e) => onChange({ colW: Number(e.target.value) })}
          />
          <span className="value">{settings.colW}px</span>
        </span>
      </label>
      <label>
        Gap
        <span className="row">
          <input type="range" min={4} max={32} step={2} value={settings.gap} onChange={(e) => onChange({ gap: Number(e.target.value) })} />
          <span className="value">{settings.gap}px</span>
        </span>
      </label>
      <label>
        Sort
        <select value={settings.sort} onChange={(e) => onChange({ sort: e.target.value as SortMode })}>
          <option value="added">Date added</option>
          <option value="author">Author</option>
          <option value="random">Shuffle</option>
        </select>
      </label>
      <label>
        Show captions
        <input type="checkbox" checked={settings.showCaptions} onChange={(e) => onChange({ showCaptions: e.target.checked })} />
      </label>
      <label>
        Show authors
        <input type="checkbox" checked={settings.showAuthors} onChange={(e) => onChange({ showAuthors: e.target.checked })} />
      </label>
      <label>
        Rounded cards
        <input type="checkbox" checked={settings.rounded} onChange={(e) => onChange({ rounded: e.target.checked })} />
      </label>
      <label>
        <span />
        <button type="button" className="hint" onClick={onReset}>
          Reset to defaults
        </button>
      </label>
    </div>
  );
}
