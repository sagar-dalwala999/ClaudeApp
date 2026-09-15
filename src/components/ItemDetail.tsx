"use client";

/**
 * Item detail.
 *
 * The picture, the written summary, the tags, and the note — which the AI only
 * ever drafts, from its key points, and only until the owner edits it.
 * Everything else can be re-fetched; the note cannot.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { mediaUrl, relativeDay, toClientItem, type ClientItem } from "@/lib/item";
import { PLATFORM_LABELS, STATUS_LABELS, TYPE_LABELS, isPlatform, isItemStatus, isItemType } from "@/lib/vocab";

interface Props {
  item: ClientItem;
  position: string;
  onClose(): void;
  onPrev(): void;
  onNext(): void;
  onChanged(item: ClientItem): void;
  onDeleted(id: string): void;
}

const DETAIL_W = 900;

export function ItemDetail({ item, position, onClose, onPrev, onNext, onChanged, onDeleted }: Props) {
  const [note, setNote] = useState(item.note ?? "");
  const [tagDraft, setTagDraft] = useState(item.tags.join(" "));
  const [tagsDirty, setTagsDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const displayedTags = tagsDirty ? tagDraft : item.tags.join(" ");

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Moving to another item remounts this component. Same-item updates keep the
  // user's note draft, while untouched AI-generated tags read from fresh props.
  useEffect(() => {
    const canvas = canvasRef.current;
    const media = item.media.find((m) => m.storageKey);
    if (!canvas || !media) return;
    const url = mediaUrl(media, "full");
    if (!url) return;
    const image = new Image();
    image.onload = () => {
      const ratio = image.naturalHeight / image.naturalWidth;
      canvas.width = DETAIL_W;
      canvas.height = Math.round(DETAIL_W * Math.min(Math.max(ratio, 0.4), 2));
      canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.src = url;
  }, [item.id, item.media]);

  const save = async (patch: Record<string, unknown>, message: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const { item: updated } = await api.patchItem(item.id, patch);
      const changed = toClientItem(updated);
      onChanged(changed);
      if (Object.hasOwn(patch, "tags")) {
        setTagDraft(changed.tags.join(" "));
        setTagsDirty(false);
      }
      setStatus(message);
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const media = item.media.find((m) => m.storageKey);
  const platformLabel = isPlatform(item.platform) ? PLATFORM_LABELS[item.platform] : item.platform;
  const statusLabel = isItemStatus(item.status) ? STATUS_LABELS[item.status] : item.status;

  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={item.title}>
      <div className="lightbox detail" onClick={(e) => e.stopPropagation()}>
        <div className="media">
          {media ? (
            <canvas ref={canvasRef} aria-label={media.alt ?? item.title} />
          ) : (
            <div className="media-empty">
              <p>{item.needsCapture ? "The picture lives behind a login." : "No picture was archived for this link."}</p>
              {item.needsCapture && (
                <p className="hint-text">
                  Capture it with the browser extension, or paste a screenshot through <code>/api/ingest</code>.
                </p>
              )}
            </div>
          )}
        </div>

        <aside className="meta">
          <header className="detail-head">
            <h2>{item.title}</h2>
            <p className="detail-sub">
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                {item.host}
              </a>
              {item.authorHandle ? ` · ${item.authorHandle}` : item.authorName ? ` · ${item.authorName}` : ""}
              {` · ${relativeDay(item.addedAt)}`}
            </p>
          </header>

          {item.summary && (
            <section className="detail-summary" aria-label={item.ai ? "AI summary" : "Summary"}>
              <span>{item.ai ? "AI summary" : "Summary"}</span>
              <p>{item.summary}</p>
            </section>
          )}

          {item.needsCapture && (
            <p className="detail-warning">
              Only the link was readable — this platform hides its content from servers.
            </p>
          )}
          {item.lastError && item.status !== "ready" && <p className="detail-warning">{item.lastError}</p>}

          <label className="detail-field">
            Note
            <textarea
              value={note}
              rows={3}
              placeholder="Why you saved it, where it belongs, what to do with it…"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save({ note }, "Note saved");
                if (e.key === "Escape") onClose();
              }}
            />
          </label>

          <label className="detail-field">
            Tags
            <input
              value={displayedTags}
              spellCheck={false}
              placeholder="space separated, e.g. llm-inference to-read"
              onChange={(e) => {
                setTagDraft(e.target.value);
                setTagsDirty(true);
              }}
            />
          </label>

          <dl className="detail-meta">
            <dt>type</dt>
            <dd>
              <select
                value={isItemType(item.type) ? item.type : "other"}
                onChange={(e) => void save({ type: e.target.value }, "Type updated")}
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </dd>
            <dt>platform</dt>
            <dd>{platformLabel}</dd>
            <dt>status</dt>
            <dd>
              {statusLabel}
              {item.ai ? " · ai written" : ""}
            </dd>
            <dt>source</dt>
            <dd>{item.source ?? "—"}</dd>
            <dt>collections</dt>
            <dd className="collections">
              {item.collections.length ? item.collections.map((c) => <span key={c.id}>{c.name}</span>) : <span>—</span>}
            </dd>
          </dl>

          {status && <p className="detail-status">{status}</p>}

          <div className="actions">
            <button type="button" className="hint" onClick={onPrev} aria-label="Previous item">
              <kbd>←</kbd>
            </button>
            <span className="position">{position}</span>
            <button type="button" className="hint" onClick={onNext} aria-label="Next item">
              <kbd>→</kbd>
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="hint primary"
              disabled={busy}
              onClick={() =>
                void save(
                  { note, tags: displayedTags.split(/[\s,]+/).filter(Boolean).map((tag) => tag.replace(/^#/, "")) },
                  "Saved",
                )
              }
            >
              save
            </button>
            <button
              type="button"
              className="hint"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.retryItem(item.id, true);
                  setStatus("Re-fetching and re-summarising…");
                } catch (err) {
                  setStatus(err instanceof ApiError ? err.message : "Could not queue the retry");
                } finally {
                  setBusy(false);
                }
              }}
            >
              re-enrich
            </button>
            <button
              type="button"
              className="hint"
              onClick={() => {
                void navigator.clipboard?.writeText(item.url).then(
                  () => setStatus("URL copied"),
                  () => setStatus("Could not copy"),
                );
              }}
            >
              copy url
            </button>
            <button type="button" className="hint" onClick={() => window.open(item.url, "_blank", "noopener")}>
              open ↗
            </button>
            {confirmDelete ? (
              <button
                type="button"
                className="hint danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.deleteItem(item.id);
                    onDeleted(item.id);
                  } catch (err) {
                    setStatus(err instanceof ApiError ? err.message : "Could not delete");
                    setBusy(false);
                  }
                }}
              >
                really delete?
              </button>
            ) : (
              <button type="button" className="hint" onClick={() => setConfirmDelete(true)}>
                delete
              </button>
            )}
            <button type="button" className="hint" onClick={onClose}>
              <kbd>esc</kbd> close
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
