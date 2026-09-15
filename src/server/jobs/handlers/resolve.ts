/**
 * Resolve handler.
 *
 * Runs the resolver chain for one item, stores what came back, and queues the
 * follow-up work. Media that was captured by the extension is treated as
 * authoritative and never overwritten by a later automatic resolve.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import { disabledResolvers } from "../../db/queries/library";
import {
  getItemByIdentity,
  replaceItemContent,
  replaceItemMedia,
  updateItem,
  type ItemRecord,
} from "../../db/queries/items";
import { itemMedia, items, resolverEvents } from "../../db/schema";
import { MAX_MEDIA_PER_ITEM } from "../../media/pipeline";
import { normalizeUrlInput, renormalizeAfterRedirect } from "../../normalize/url";
import { resolveItem } from "../../resolve";
import type { ResolverEvent } from "../../resolve/types";
import { wordCount } from "../../text/html";
import { BODY_TEXT_LIMIT, capJsonForStorage, clampText, HTML_LIMIT, SUMMARY_LIMIT, TITLE_LIMIT } from "../../text/size";
import { enqueue, QUEUE } from "../queue";

export interface ResolvePayload {
  itemId: string;
  userId: string;
  force?: boolean;
}

async function recordEvents(itemId: string, events: ResolverEvent[]): Promise<void> {
  if (!events.length) return;
  await getDb()
    .insert(resolverEvents)
    .values(
      events.map((event) => ({
        itemId,
        resolver: event.resolver,
        outcome: event.outcome,
        httpStatus: event.httpStatus,
        latencyMs: event.latencyMs,
        error: event.error,
      })),
    );
}

export async function handleResolve(payload: ResolvePayload): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(items).where(eq(items.id, payload.itemId)).limit(1);
  const row = rows[0];
  if (!row) {
    console.warn(`[resolve] item ${payload.itemId} no longer exists`);
    return;
  }
  if (!payload.force && row.status === "ready" && row.title) {
    return;
  }

  let normalized;
  try {
    normalized = normalizeUrlInput(row.url);
  } catch (err) {
    await updateItem(row.userId, row.id, {
      status: "unread",
      summary: "[content unavailable]",
      lastError: err instanceof Error ? err.message : "unparseable URL",
      fetchedAt: new Date(),
    });
    return;
  }

  const skip = await disabledResolvers();
  const run = await resolveItem(normalized, { itemId: row.id, skip });
  await recordEvents(row.id, run.events);

  const { content } = run;

  // Identity can change after redirects or a canonical tag — but only when no
  // other item already owns the new identity.
  let identityPatch: Record<string, unknown> = {};
  if (content.url && content.canonical !== undefined) {
    const renormalized = renormalizeAfterRedirect(normalized, content.url, content.canonical ?? null);
    if (renormalized.identityKey !== row.identityKey) {
      const clash = await getItemByIdentity(row.userId, renormalized.identityKey);
      if (!clash || clash.id === row.id) {
        identityPatch = {
          url: renormalized.url,
          canonicalUrl: renormalized.canonicalUrl,
          identityKey: renormalized.identityKey,
          platform: renormalized.platform,
        };
      }
    }
  }

  const hasAnything = Boolean(content.title || content.text || content.summary || content.media?.length);
  if (!hasAnything) {
    await updateItem(row.userId, row.id, {
      status: "unread",
      summary: row.summary ?? "[content unavailable]",
      lastError: run.events.find((e) => e.outcome === "error")?.error ?? "no resolver could read this link",
      fetchedAt: new Date(),
      ...identityPatch,
    });
    // Still worth an AI pass: it can classify from the URL alone.
    await enqueue(QUEUE.enrich, { itemId: row.id }, { singletonKey: row.id });
    return;
  }

  const title = clampText(content.title ?? null, TITLE_LIMIT);
  const summary = clampText(content.summary ?? null, SUMMARY_LIMIT);
  const bodyText = clampText(content.text ?? null, BODY_TEXT_LIMIT);

  await updateItem(row.userId, row.id, {
    title: title ?? row.title,
    summary: summary ?? row.summary,
    author: content.author ?? row.author,
    authorHandle: content.authorHandle ?? row.authorHandle,
    siteName: content.siteName ?? row.siteName,
    language: content.language ?? row.language,
    publishedAt: content.publishedAt ?? row.publishedAt,
    type: content.type ?? row.type,
    bodyText,
    source: run.source,
    status: "pending",
    lastError: null,
    fetchedAt: new Date(),
    ...identityPatch,
  });

  await replaceItemContent(row.id, {
    text: bodyText,
    html: clampText(content.html ?? null, HTML_LIMIT),
    og: content.meta ? capJsonForStorage(content.meta) : null,
    wordCount: bodyText ? wordCount(bodyText) : 0,
    resolver: run.source,
  });

  // Never clobber a picture the extension captured from the owner's browser.
  const captured = await db
    .select({ id: itemMedia.id })
    .from(itemMedia)
    .where(and(eq(itemMedia.itemId, row.id), isNotNull(itemMedia.storageKey)))
    .limit(1);

  let mediaQueued = false;
  if (!captured.length) {
    const seen = new Set<string>();
    const media = (content.media ?? [])
      .filter((entry) => {
        if (!entry.remoteUrl || seen.has(entry.remoteUrl)) return false;
        seen.add(entry.remoteUrl);
        return true;
      })
      .slice(0, MAX_MEDIA_PER_ITEM);

    if (media.length) {
      await replaceItemMedia(
        row.id,
        media.map((entry) => ({
          kind: entry.kind,
          remoteUrl: entry.remoteUrl,
          width: entry.width ?? null,
          height: entry.height ?? null,
          alt: entry.alt ?? title ?? null,
        })),
      );
      mediaQueued = true;
    }
  }

  if (mediaQueued) await enqueue(QUEUE.media, { itemId: row.id }, { singletonKey: row.id });
  await enqueue(QUEUE.enrich, { itemId: row.id, force: payload.force }, { singletonKey: row.id });
}

/** Re-runs the full pipeline for an item, regardless of its current state. */
export async function handleReindex(item: ItemRecord): Promise<void> {
  await handleResolve({ itemId: item.id, userId: item.userId, force: true });
}
