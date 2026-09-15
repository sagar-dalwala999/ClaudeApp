/**
 * Enrichment: turn a fetched item into a catalogue entry.
 *
 * Order of operations matters here.
 *   1. Skip if the content has not changed since the last enrichment — this is
 *      what keeps re-runs (and retries) from paying for the same text twice.
 *   2. Enrich with structured output, sanitise every field, then embed and
 *      reconcile tags.
 *
 * A title the owner edited by hand is never overwritten: manual patches set
 * `source = 'manual'`, and this module leaves those alone.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { isItemType, type ItemType } from "../../lib/vocab";
import { getDb } from "../db/client";
import { getItemContent, updateItem } from "../db/queries/items";
import { listCollections, listTags } from "../db/queries/library";
import { enrichments, items } from "../db/schema";
import { estimateCostMicros } from "../limits/cost";
import { noteSeed, renderNoteSeed } from "../text/notes";
import { clampText, SUMMARY_LIMIT, TITLE_LIMIT } from "../text/size";
import { normalizeTags } from "../text/tags";
import { assignTags } from "./tags";
import { AiProviderError, aiConfigured, completeJson, embedText, embeddingsConfigured } from "./openai";
import {
  BODY_CHAR_BUDGET,
  buildUserPrompt,
  ENRICHMENT_SCHEMA,
  parseEnrichmentResponse,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
} from "./prompts";

export interface EnrichmentOutcome {
  enriched: boolean;
  reason: string | null;
  model: string | null;
  costMicros: number;
  tags: string[];
  title: string | null;
  embeddingStored: boolean;
}

function contentHashOf(parts: Array<string | null | undefined>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex");
}

async function recordEnrichment(row: {
  itemId: string;
  kind: "enrich" | "embed";
  model: string;
  inputHash: string | null;
  response: unknown;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  error: string | null;
}): Promise<void> {
  await getDb().insert(enrichments).values({
    itemId: row.itemId,
    kind: row.kind,
    model: row.model,
    promptVersion: PROMPT_VERSION,
    inputHash: row.inputHash,
    response: row.response as Record<string, unknown> | null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicros: row.costMicros,
    latencyMs: row.latencyMs,
    error: row.error,
  });
}

function sanitizeTitle(candidate: string | null | undefined, fallback: string | null, siteName: string | null): string | null {
  const value = candidate?.replace(/\s+/g, " ").trim();
  if (!value || value.length < 2) return fallback;
  const lower = value.toLowerCase();
  const junk = ["untitled", "page not found", "404", "not found", "access denied", "log in", "login"];
  if (junk.some((j) => lower === j || lower.startsWith(`${j} |`))) return fallback;
  if (siteName && lower === siteName.toLowerCase()) return fallback;
  if (siteName && lower === `${siteName} | ${siteName}`.toLowerCase()) return fallback;
  return clampText(value, TITLE_LIMIT);
}

function keyPointsOf(response: unknown): string[] {
  const points = (response as { key_points?: unknown } | null | undefined)?.key_points;
  return Array.isArray(points) ? points.filter((point): point is string => typeof point === "string").slice(0, 3) : [];
}

/**
 * Is the stored note still one of our drafts?
 *
 * Every recent run that returned a payload is asked what it would have written,
 * and the note counts as ours if it matches any of them. Judging by the newest
 * payload alone would strand a draft as owner-written: a failed run stores no
 * payload at all, and a run that lost the race to write leaves the note lagging
 * behind the payload that follows it.
 */
async function noteIsOurDraft(itemId: string, note: string | null): Promise<boolean> {
  const current = (note ?? "").trim();
  if (!current) return true;
  const rows = await getDb()
    .select({ response: enrichments.response })
    .from(enrichments)
    .where(and(eq(enrichments.itemId, itemId), eq(enrichments.kind, "enrich"), isNotNull(enrichments.response)))
    .orderBy(desc(enrichments.createdAt))
    .limit(20);
  return rows.some((row) => renderNoteSeed(keyPointsOf(row.response)) === current);
}

export async function enrichItem(itemId: string): Promise<EnrichmentOutcome> {
  const db = getDb();
  const rows = await db.select().from(items).where(eq(items.id, itemId)).limit(1);
  const row = rows[0];
  if (!row) return { enriched: false, reason: "item not found", model: null, costMicros: 0, tags: [], title: null, embeddingStored: false };

  const content = await getItemContent(itemId);
  const bodyText = row.bodyText ?? content?.text ?? null;
  const hash = contentHashOf([row.url, row.title, bodyText]);
  const manual = row.source === "manual";

  if (row.ai && row.contentHash === hash) {
    return { enriched: false, reason: "content unchanged since last enrichment", model: null, costMicros: 0, tags: [], title: row.title, embeddingStored: false };
  }
  if (manual && row.ai) {
    return { enriched: false, reason: "title was edited by hand", model: null, costMicros: 0, tags: [], title: row.title, embeddingStored: false };
  }

  const userId = row.userId;

  // No chat model configured: keep the archive usable without a written summary.
  if (!aiConfigured()) {
    await updateItem(userId, itemId, {
      status: row.status === "failed" ? "ready" : row.status === "pending" ? "ready" : row.status,
      contentHash: hash,
      fetchedAt: new Date(),
      lastError: row.lastError,
    });
    return {
      enriched: false,
      reason: "AI_CHAT_MODEL is not set, so no summary was written",
      model: null,
      costMicros: 0,
      tags: [],
      title: row.title,
      embeddingStored: false,
    };
  }

  // A sample of the vocabulary already in use, so the model reuses tags
  // instead of inventing a near-duplicate every time. Collections ride along so
  // the note draft can say where the thing belongs in this archive.
  const [vocabulary, collections] = await Promise.all([
    listTags(userId, 40).catch(() => []),
    listCollections(userId).catch(() => []),
  ]);

  const userPrompt = buildUserPrompt({
    url: row.url,
    platform: row.platform,
    siteName: row.siteName,
    author: row.author ?? row.authorHandle,
    title: row.title,
    description: row.summary,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString().slice(0, 10) : null,
    existingTags: vocabulary.map((tag) => tag.name),
    collections: collections.map((collection) => collection.name),
    userNote: row.note,
    bodyText: bodyText ? bodyText.slice(0, BODY_CHAR_BUDGET) : null,
    hint: row.type,
  });

  let completion;
  try {
    const rawCompletion = await completeJson<unknown>({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      schemaName: "link_entry",
      schema: ENRICHMENT_SCHEMA,
    });
    completion = { ...rawCompletion, data: parseEnrichmentResponse(rawCompletion.data) };
  } catch (err) {
    const message = err instanceof AiProviderError ? err.message : err instanceof Error ? err.message : String(err);
    await recordEnrichment({
      itemId,
      kind: "enrich",
      model: "unknown",
      inputHash: hash,
      response: null,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      latencyMs: 0,
      error: message.slice(0, 500),
    });
    await updateItem(userId, itemId, { status: "ready", contentHash: hash, lastError: `AI enrichment failed: ${message}`.slice(0, 500) });
    // A rate limit or a 5xx deserves another go: the queue retries with backoff.
    // Swallowing it here is what wrote items off for good after one 429.
    if (err instanceof AiProviderError && err.retryable) throw err;
    return { enriched: false, reason: message, model: null, costMicros: 0, tags: [], title: row.title, embeddingStored: false };
  }

  const costMicros = estimateCostMicros(completion.model, completion.inputTokens, completion.outputTokens);
  await recordEnrichment({
    itemId,
    kind: "enrich",
    model: completion.model,
    inputHash: hash,
    response: completion.data as unknown as Record<string, unknown>,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    costMicros,
    latencyMs: completion.latencyMs,
    error: null,
  });

  const data = completion.data;
  const title = sanitizeTitle(data.title, row.title, row.siteName);
  const summary = clampText((data.summary ?? "").replace(/\s+/g, " ").trim(), SUMMARY_LIMIT);
  const type: ItemType = isItemType(data.type) ? data.type : (row.type as ItemType);
  const tags = normalizeTags(Array.isArray(data.tags) ? data.tags.slice(0, 8) : []);
  const language = /^[a-z]{2}$/i.test(data.language ?? "") ? (data.language as string).toLowerCase() : row.language;

  // The paragraph is the summary. The bullets are not: they are the first draft
  // of the owner's note, written only over an empty note or over the draft the
  // previous run left behind.
  const keyPoints = keyPointsOf(data);
  const note = noteSeed(keyPoints, row.note, await noteIsOurDraft(itemId, row.note));

  // Embeddings are optional: chat-only providers still produce full summaries.
  let embeddingStored = false;
  if (embeddingsConfigured()) {
    try {
      const embedSource = [title ?? row.title ?? "", summary ?? "", (bodyText ?? "").slice(0, 2_000)].join("\n\n");
      const { vector, model, inputTokens } = await embedText(embedSource);
      const embedCost = estimateCostMicros(model, inputTokens, 0);
      if (vector?.length) {
        await updateItem(userId, itemId, { embedding: vector });
        embeddingStored = true;
      }
      await recordEnrichment({
        itemId,
        kind: "embed",
        model,
        inputHash: hash,
        response: null,
        inputTokens,
        outputTokens: 0,
        costMicros: embedCost,
        latencyMs: 0,
        error: vector?.length ? null : "no vector returned",
      });
    } catch (err) {
      await recordEnrichment({
        itemId,
        kind: "embed",
        model: "unknown",
        inputHash: hash,
        response: null,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        latencyMs: 0,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      });
    }
  }

  const assigned = tags.length ? await assignTags(userId, itemId, tags, "ai") : { names: [], aliases: [], embedded: 0 };

  await updateItem(userId, itemId, {
    title,
    summary: summary || row.summary,
    note,
    type,
    language: language ?? null,
    status: "ready",
    ai: true,
    source: "ai",
    contentHash: hash,
    fetchedAt: new Date(),
    lastError: null,
  });

  return {
    enriched: true,
    reason: null,
    model: completion.model,
    costMicros,
    tags: assigned.names,
    title,
    embeddingStored,
  };
}

/** Re-runs enrichment for a single item, ignoring the unchanged-content guard. */
export async function forceEnrichItem(itemId: string): Promise<EnrichmentOutcome> {
  await getDb().update(items).set({ contentHash: null, ai: false, source: null }).where(eq(items.id, itemId));
  return enrichItem(itemId);
}
