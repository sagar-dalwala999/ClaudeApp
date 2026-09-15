"use client";

/**
 * The paste bar.
 *
 * The whole app in one input: paste a link, it is fetched, summarised and filed
 * while you keep working. The result of the last capture stays visible so the
 * duplicate case is obvious rather than silent.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { isProbablyUrl } from "@/lib/url";

export interface CaptureOutcome {
  kind: "saved" | "duplicate" | "error";
  message: string;
}

interface Props {
  open: boolean;
  onClose(): void;
  onSaved(): void;
  onOutcome(outcome: CaptureOutcome | null): void;
  outcome: CaptureOutcome | null;
  collectionId: string | null;
}

export function CaptureBar({ open, onClose, onSaved, onOutcome, outcome, collectionId }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    const input = value.trim();
    if (!input || busy) return;
    if (!isProbablyUrl(input)) {
      onOutcome({ kind: "error", message: "That doesn't look like a link" });
      return;
    }
    setBusy(true);
    onOutcome(null);
    try {
      const result = await api.createItem(input, collectionId);
      if (result.duplicate) {
        onOutcome({
          kind: "duplicate",
          message: `Already saved — “${result.item.title ?? result.item.url}”. Opened it for you.`,
        });
      } else {
        onOutcome({ kind: "saved", message: `Saved “${result.item.title ?? result.item.url}”. Fetching…` });
      }
      setValue("");
      onSaved();
      if (result.duplicate) {
        window.setTimeout(() => onClose(), 600);
      }
    } catch (err) {
      onOutcome({ kind: "error", message: err instanceof ApiError ? err.message : "Could not save that link" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="capture" role="dialog" aria-label="Save a link">
      <div className="capture-inner">
        <span className="capture-label">Save</span>
        <input
          ref={inputRef}
          value={value}
          placeholder="Paste any link — article, repo, post, paper, video…"
          aria-label="Link to save"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") onClose();
          }}
        />
        <button type="button" className="hint primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
          {busy ? "saving…" : "enter"}
        </button>
        <button type="button" className="hint" onClick={onClose}>
          esc
        </button>
      </div>
      {outcome && <p className={`capture-outcome ${outcome.kind}`}>{outcome.message}</p>}
    </div>
  );
}
