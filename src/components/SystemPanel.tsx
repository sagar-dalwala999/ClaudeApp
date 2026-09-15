"use client";

/**
 * Settings: the operational half of the app.
 *
 * Ingest tokens for the extension and Shortcuts, the health of every resolver
 * (these break; the table is how you notice), queue depth, AI spend against the
 * daily cap, and the markdown export.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type IngestTokenSummary, type SystemResponse } from "@/lib/api";
import { formatBytes } from "@/lib/format";

function micros(amount: number): string {
  return `$${(amount / 1e6).toFixed(2)}`;
}

export function SystemPanel() {
  const [system, setSystem] = useState<SystemResponse | null>(null);
  const [tokens, setTokens] = useState<IngestTokenSummary[]>([]);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [newTokenName, setNewTokenName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [systemResult, tokenResult] = await Promise.all([api.system(), api.listTokens()]);
      setSystem(systemResult);
      setTokens(tokenResult.tokens);
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Could not load system status");
    }
  }, []);

  useEffect(() => {
    // Kick the first read off the effect body: the poll below owns every
    // state update, so nothing renders synchronously inside the effect.
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  const createToken = async () => {
    const name = newTokenName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const result = await api.createToken(name);
      setFreshToken(result.token);
      setNewTokenName("");
      await refresh();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Could not create the token");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="system">
      <section>
        <h2>Enrichment</h2>
        {system ? (
          <dl className="system-grid">
            <dt>AI</dt>
            <dd>
              {system.ai.configured
                ? `${system.ai.model} · embeddings ${system.ai.embedModel || "off"}`
                : "disabled — no AI_CHAT_MODEL"}
            </dd>
            <dt>Spend today</dt>
            <dd>{micros(system.ai.spentTodayMicros)}</dd>
            <dt>Links</dt>
            <dd>
              {system.stats.items} total · {system.stats.ready} ready · {system.stats.pending} fetching ·{" "}
              {system.stats.failed} failed
            </dd>
            <dt>Media</dt>
            <dd>
              {system.stats.mediaCount} files · {formatBytes(system.stats.mediaBytes)} · storage {system.config.storage}
            </dd>
            <dt>Added</dt>
            <dd>
              {system.stats.addedToday} today · {system.stats.addedThisWeek} this week
            </dd>
          </dl>
        ) : (
          <p className="hint-text">Loading…</p>
        )}
      </section>

      <section>
        <h2>Resolvers</h2>
        <p className="hint-text">
          Every adapter, its hit rate over the last week, and whether it has been auto-disabled after repeated failures
          (five in a row stands it down until it succeeds again).
        </p>
        <table className="system-table">
          <thead>
            <tr>
              <th>resolver</th>
              <th>hit rate</th>
              <th>p50</th>
              <th>errors</th>
              <th>last error</th>
            </tr>
          </thead>
          <tbody>
            {(system?.resolvers ?? []).map((row) => (
              <tr key={row.resolver} className={row.disabled ? "disabled" : undefined}>
                <td>
                  {row.resolver}
                  {row.disabled ? " (disabled)" : ""}
                </td>
                <td>{row.attempts ? `${Math.round(row.successRate * 100)}%` : "—"}</td>
                <td>{row.p50LatencyMs ? `${row.p50LatencyMs} ms` : "—"}</td>
                <td>{row.errors}</td>
                <td className="error-cell">{row.lastError ?? "—"}</td>
              </tr>
            ))}
            {!system?.resolvers.length && (
              <tr>
                <td colSpan={5}>No resolver activity yet.</td>
              </tr>
            )}
          </tbody>
        </table>
        {system && (
          <ul className="system-config">
            {system.catalogue.map((entry) => (
              <li key={entry.id}>
                <code>{entry.id}</code>
                {entry.unavailable ? ` — ${entry.unavailable}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Queue</h2>
        <ul className="system-config">
          {(system?.queues ?? []).map((queue) => (
            <li key={queue.name}>
              <code>{queue.name}</code> — {queue.queued} queued, {queue.active} active, {queue.failed} failed
            </li>
          ))}
          {!system?.queues.length && <li>Queue stats are unavailable (is the worker running?)</li>}
        </ul>
      </section>

      <section>
        <h2>Ingest tokens</h2>
        <p className="hint-text">
          For the browser extension, an iOS Shortcut, or <code>curl</code>. Send one as{" "}
          <code>Authorization: Bearer …</code> to <code>POST /api/ingest</code>. Tokens are stored hashed, so a new one
          is shown exactly once.
        </p>
        <div className="token-create">
          <input
            value={newTokenName}
            placeholder="What is it for? (e.g. Arc extension)"
            aria-label="Token name"
            onChange={(e) => setNewTokenName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createToken();
            }}
          />
          <button type="button" className="hint primary" disabled={busy || !newTokenName.trim()} onClick={() => void createToken()}>
            create
          </button>
        </div>
        {freshToken && (
          <div className="token-fresh">
            <p>Copy this now — it cannot be shown again.</p>
            <code>{freshToken}</code>
            <button
              type="button"
              className="hint"
              onClick={() => {
                void navigator.clipboard?.writeText(freshToken).then(() => setStatus("Token copied"));
              }}
            >
              copy
            </button>
          </div>
        )}
        <ul className="token-list">
          {tokens.map((token) => (
            <li key={token.id} className={token.revokedAt ? "revoked" : undefined}>
              <span>{token.name}</span>
              <span className="hint-text">
                {token.revokedAt
                  ? "revoked"
                  : token.lastUsedAt
                    ? `last used ${new Date(token.lastUsedAt).toLocaleString()}`
                    : "never used"}
              </span>
              {!token.revokedAt && (
                <button
                  type="button"
                  className="hint"
                  onClick={async () => {
                    await api.revokeToken(token.id).catch(() => undefined);
                    await refresh();
                  }}
                >
                  revoke
                </button>
              )}
            </li>
          ))}
          {!tokens.length && <li className="hint-text">No tokens yet.</li>}
        </ul>
      </section>

      <section>
        <h2>Markdown export</h2>
        <p className="hint-text">
          The archive as an Obsidian vault: <code>INDEX.md</code> plus one note per day.{" "}
          {system?.config.obsidianVault
            ? "A vault path is configured, so this can be mirrored to disk."
            : "Set OBSIDIAN_VAULT_PATH to mirror it to disk automatically."}
        </p>
        <div className="token-create">
          <button
            type="button"
            className="hint"
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.exportFiles(200);
                setExportPreview(result.files["INDEX.md"]?.slice(0, 4_000) ?? "No entries yet.");
              } catch (err) {
                setStatus(err instanceof ApiError ? err.message : "Export failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            preview INDEX.md
          </button>
          <a className="hint" href="/api/export?file=INDEX.md">
            download INDEX.md
          </a>
          {system?.config.obsidianVault && (
            <button
              type="button"
              className="hint"
              onClick={async () => {
                try {
                  await api.mirrorExport();
                  setStatus("Mirror queued — the worker will write the files");
                } catch (err) {
                  setStatus(err instanceof ApiError ? err.message : "Could not queue the mirror");
                }
              }}
            >
              mirror to vault
            </button>
          )}
        </div>
        {exportPreview && <pre className="export-preview">{exportPreview}</pre>}
      </section>

      {status && <p className="detail-status">{status}</p>}
    </div>
  );
}
