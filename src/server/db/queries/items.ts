/**
 * Item queries.
 *
 * Rows are fetched in three statements (items, their media, their tags) and
 * assembled in memory: one predictable round trip per concern beats a wide
 * join that duplicates rows and complicates page limits.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { ItemStatus, ItemType, Platform } from "../../../lib/vocab";
import { getDb, rawRows } from "../client";
import { collectionItems, collections, itemContent, itemMedia, itemTags, items, tags } from "../schema";
import { normalizeTag } from "../../text/tags";

export type ItemRow = typeof items.$inferSelect;
export type MediaRow = typeof itemMedia.$inferSelect;

export interface MediaRecord {
  id: string;
  kind: string;
  remoteUrl: string | null;
  storageKey: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  placeholder: string | null;
  alt: string | null;
  position: number;
}

export interface ItemRecord {
  id: string;
  userId: string;
  url: string;
  canonicalUrl: string;
  platform: string;
  type: string;
  title: string | null;
  summary: string | null;
  author: string | null;
  authorHandle: string | null;
  siteName: string | null;
  language: string | null;
  publishedAt: string | null;
  status: string;
  source: string | null;
  note: string | null;
  bodyText: string | null;
  ai: boolean;
  favorite: boolean;
  lastError: string | null;
  addedAt: string;
  updatedAt: string;
  media: MediaRecord[];
  tags: string[];
  collections: Array<{ id: string; name: string }>;
  hasEmbedding: boolean;
  /**
   * Derived, not stored: a gated platform where we ended up with almost no
   * text and no picture, which is the case the browser extension exists for.
   */
  needsCapture: boolean;
}

/** Platforms that hide content behind a login. */
const GATED_PLATFORMS = new Set(["instagram", "facebook", "threads", "x"]);

export interface ListOptions {
  userId: string;
  collectionId?: string | null;
  tag?: string | null;
  type?: string | null;
  status?: string | null;
  favoriteOnly?: boolean;
  sort?: "added" | "oldest" | "author" | "title";
  cursor?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

/* ------------------------------------------------------------- mapping */

function serializeRow(row: ItemRow, media: MediaRecord[], tagList: string[], collectionList: Array<{ id: string; name: string }>): ItemRecord {
  return {
    id: row.id,
    userId: row.userId,
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    platform: row.platform,
    type: row.type,
    title: row.title,
    summary: row.summary,
    author: row.author,
    authorHandle: row.authorHandle,
    siteName: row.siteName,
    language: row.language,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    status: row.status,
    source: row.source,
    note: row.note,
    bodyText: row.bodyText,
    ai: row.ai,
    favorite: row.favorite,
    lastError: row.lastError,
    addedAt: row.addedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    media,
    tags: tagList,
    collections: collectionList,
    hasEmbedding: row.embedding !== null && row.embedding !== undefined,
    needsCapture:
      GATED_PLATFORMS.has(row.platform) &&
      media.length === 0 &&
      (row.summary ?? "").trim().length < 40 &&
      (row.bodyText ?? "").trim().length < 120,
  };
}

async function attachRelations(userId: string, rows: ItemRow[]): Promise<ItemRecord[]> {
  if (!rows.length) return [];
  const db = getDb();
  const ids = rows.map((r) => r.id);

  const mediaRows = await db
    .select()
    .from(itemMedia)
    .where(inArray(itemMedia.itemId, ids))
    .orderBy(itemMedia.position);
  const tagRows = await db
    .select({ itemId: itemTags.itemId, name: tags.name })
    .from(itemTags)
    .innerJoin(tags, eq(tags.id, itemTags.tagId))
    .where(inArray(itemTags.itemId, ids));
  const collectionRows = await db
    .select({ itemId: collectionItems.itemId, id: collections.id, name: collections.name })
    .from(collectionItems)
    .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
    .where(and(inArray(collectionItems.itemId, ids), eq(collections.userId, userId)));

  const mediaByItem = new Map<string, MediaRecord[]>();
  for (const m of mediaRows) {
    const list = mediaByItem.get(m.itemId) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      remoteUrl: m.remoteUrl,
      storageKey: m.storageKey,
      width: m.width,
      height: m.height,
      bytes: m.bytes,
      placeholder: m.placeholder,
      alt: m.alt,
      position: m.position,
    });
    mediaByItem.set(m.itemId, list);
  }

  const tagsByItem = new Map<string, string[]>();
  for (const t of tagRows) {
    const list = tagsByItem.get(t.itemId) ?? [];
    list.push(t.name);
    tagsByItem.set(t.itemId, list);
  }

  const collectionsByItem = new Map<string, Array<{ id: string; name: string }>>();
  for (const c of collectionRows) {
    const list = collectionsByItem.get(c.itemId) ?? [];
    list.push({ id: c.id, name: c.name });
    collectionsByItem.set(c.itemId, list);
  }

  return rows.map((row) =>
    serializeRow(row, mediaByItem.get(row.id) ?? [], (tagsByItem.get(row.id) ?? []).sort(), collectionsByItem.get(row.id) ?? []),
  );
}

/* --------------------------------------------------------------- reads */

function encodeCursor(row: ItemRow): string {
  return Buffer.from(`${row.addedAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { addedAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = raw.lastIndexOf("|");
    if (separator === -1) return null;
    const addedAt = raw.slice(0, separator);
    const id = raw.slice(separator + 1);
    if (!addedAt || !id) return null;
    return { addedAt, id };
  } catch {
    return null;
  }
}

export interface ListResult {
  items: ItemRecord[];
  nextCursor: string | null;
  total: number;
}

export async function listItems(opts: ListOptions): Promise<ListResult> {
  const db = getDb();
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const conditions = [eq(items.userId, opts.userId)];
  if (opts.type) conditions.push(eq(items.type, opts.type));
  if (opts.status) conditions.push(eq(items.status, opts.status));
  if (opts.favoriteOnly) conditions.push(eq(items.favorite, true));

  if (opts.collectionId) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${collectionItems} ci WHERE ci.item_id = ${items.id} AND ci.collection_id = ${opts.collectionId}::uuid)`,
    );
  }
  if (opts.tag) {
    const tag = normalizeTag(opts.tag);
    if (tag) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${itemTags} it
          JOIN ${tags} t ON t.id = it.tag_id
          WHERE it.item_id = ${items.id} AND t.name = ${tag}
        )`,
      );
    }
  }

  const sort = opts.sort ?? "added";
  const orderBy =
    sort === "oldest"
      ? [items.addedAt, items.id]
      : sort === "author"
        ? [sql`lower(coalesce(${items.author}, ''))`, items.addedAt]
        : sort === "title"
          ? [sql`lower(coalesce(${items.title}, ''))`, items.addedAt]
          : [desc(items.addedAt), desc(items.id)];

  const where = [...conditions];
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor && (sort === "added" || sort === "oldest")) {
    const comparator = sort === "added" ? sql`<` : sql`>`;
    where.push(sql`(${items.addedAt}, ${items.id}) ${comparator} (${new Date(cursor.addedAt)}, ${cursor.id}::uuid)`);
  }

  const rows = await db
    .select()
    .from(items)
    .where(and(...where))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const records = await attachRelations(opts.userId, page);
  return {
    items: records,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    total: 0,
  };
}

export async function countItems(opts: Omit<ListOptions, "cursor" | "limit">): Promise<number> {
  const result = await listItems({ ...opts, limit: MAX_LIMIT });
  return result.items.length;
}

export async function getItems(userId: string, ids: string[]): Promise<ItemRecord[]> {
  if (!ids.length) return [];
  const rows = await getDb()
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), inArray(items.id, ids)));
  return attachRelations(userId, rows);
}

export async function getItem(userId: string, id: string): Promise<ItemRecord | null> {
  const rows = await getDb()
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.id, id)))
    .limit(1);
  const [record] = await attachRelations(userId, rows);
  return record ?? null;
}

export async function getItemByIdentity(userId: string, identityKey: string): Promise<ItemRecord | null> {
  const rows = await getDb()
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.identityKey, identityKey)))
    .limit(1);
  const [record] = await attachRelations(userId, rows);
  return record ?? null;
}

export async function getItemContent(itemId: string) {
  const rows = await getDb().select().from(itemContent).where(eq(itemContent.itemId, itemId)).limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------- writes */

export interface InsertItemInput {
  userId: string;
  url: string;
  canonicalUrl: string;
  identityKey: string;
  platform: Platform | string;
  type: ItemType | string;
  status?: ItemStatus;
  source?: string | null;
  collectionId?: string | null;
}

export interface InsertResult {
  item: ItemRecord;
  created: boolean;
}

/**
 * Inserts unless the identity already exists for this user, in which case the
 * existing item is returned. The unique index is the source of truth, so two
 * concurrent pastes of the same link cannot both win.
 */
export async function insertItem(input: InsertItemInput): Promise<InsertResult> {
  const db = getDb();
  const inserted = await db
    .insert(items)
    .values({
      userId: input.userId,
      url: input.url,
      canonicalUrl: input.canonicalUrl,
      identityKey: input.identityKey,
      platform: input.platform,
      type: input.type,
      status: input.status ?? "pending",
      source: input.source ?? null,
    })
    .onConflictDoNothing({ target: [items.userId, items.identityKey] })
    .returning();

  if (inserted.length) {
    const record = await attachRelations(input.userId, inserted);
    if (input.collectionId) await addToCollection(input.collectionId, record[0].id);
    return { item: record[0], created: true };
  }

  const existing = await getItemByIdentity(input.userId, input.identityKey);
  if (!existing) throw new Error("Insert conflicted but no existing item was found");
  return { item: existing, created: false };
}

export interface ItemPatch {
  title?: string | null;
  summary?: string | null;
  note?: string | null;
  type?: string;
  status?: string;
  author?: string | null;
  authorHandle?: string | null;
  siteName?: string | null;
  language?: string | null;
  publishedAt?: Date | null;
  bodyText?: string | null;
  platform?: string;
  url?: string;
  canonicalUrl?: string;
  identityKey?: string;
  source?: string | null;
  ai?: boolean;
  favorite?: boolean;
  contentHash?: string | null;
  lastError?: string | null;
  fetchedAt?: Date | null;
  embedding?: number[] | null;
}

export async function updateItem(userId: string, id: string, patch: ItemPatch): Promise<ItemRecord | null> {
  const updated = await getDb()
    .update(items)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(items.userId, userId), eq(items.id, id)))
    .returning();
  if (!updated.length) return null;
  const [record] = await attachRelations(userId, updated);
  return record ?? null;
}

export async function deleteItem(userId: string, id: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(items)
    .where(and(eq(items.userId, userId), eq(items.id, id)))
    .returning({ id: items.id });
  return deleted.length > 0;
}

export async function replaceItemContent(
  itemId: string,
  content: { text?: string | null; html?: string | null; og?: Record<string, unknown> | null; wordCount?: number; resolver?: string | null },
): Promise<void> {
  const db = getDb();
  await db
    .insert(itemContent)
    .values({
      itemId,
      text: content.text ?? null,
      html: content.html ?? null,
      og: content.og ?? null,
      wordCount: content.wordCount ?? 0,
      resolver: content.resolver ?? null,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: itemContent.itemId,
      set: {
        text: content.text ?? null,
        html: content.html ?? null,
        og: content.og ?? null,
        wordCount: content.wordCount ?? 0,
        resolver: content.resolver ?? null,
        fetchedAt: new Date(),
      },
    });
}

export async function replaceItemMedia(
  itemId: string,
  media: Array<{
    kind?: string;
    remoteUrl?: string | null;
    storageKey?: string | null;
    width?: number | null;
    height?: number | null;
    bytes?: number | null;
    placeholder?: string | null;
    alt?: string | null;
  }>,
): Promise<string[]> {
  const db = getDb();
  await db.delete(itemMedia).where(eq(itemMedia.itemId, itemId));
  if (!media.length) return [];
  const inserted = await db
    .insert(itemMedia)
    .values(
      media.map((m, index) => ({
        itemId,
        kind: m.kind ?? "image",
        remoteUrl: m.remoteUrl ?? null,
        storageKey: m.storageKey ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        bytes: m.bytes ?? null,
        placeholder: m.placeholder ?? null,
        alt: m.alt ?? null,
        position: index,
      })),
    )
    .returning();
  return inserted.map((row) => row.id);
}

export async function setMediaStorage(itemId: string, updates: Array<{ id: string; storageKey: string; width?: number | null; height?: number | null; bytes?: number | null; placeholder?: string | null }>): Promise<void> {
  const db = getDb();
  for (const update of updates) {
    await db
      .update(itemMedia)
      .set({
        storageKey: update.storageKey,
        width: update.width ?? null,
        height: update.height ?? null,
        bytes: update.bytes ?? null,
        placeholder: update.placeholder ?? null,
      })
      .where(and(eq(itemMedia.itemId, itemId), eq(itemMedia.id, update.id)));
  }
}

/** Upserts tags and links them, replacing only the AI-sourced links. */
export async function setItemTags(
  userId: string,
  itemId: string,
  tagNames: string[],
  source: "ai" | "user" = "ai",
): Promise<string[]> {
  const db = getDb();
  const normalized = [...new Set(tagNames.map(normalizeTag).filter((t): t is string => Boolean(t)))];
  if (source === "ai") {
    await db.delete(itemTags).where(and(eq(itemTags.itemId, itemId), eq(itemTags.source, "ai")));
  }
  if (!normalized.length) return [];

  await db
    .insert(tags)
    .values(normalized.map((name) => ({ userId, name, label: name })))
    .onConflictDoNothing({ target: [tags.userId, tags.name] });

  const tagRows = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.name, normalized)));

  await db
    .insert(itemTags)
    .values(tagRows.map((t) => ({ itemId, tagId: t.id, source })))
    .onConflictDoNothing({ target: [itemTags.itemId, itemTags.tagId] });

  return tagRows.map((t) => t.name);
}

export async function removeTagFromItem(userId: string, itemId: string, tagName: string): Promise<boolean> {
  const tag = normalizeTag(tagName);
  if (!tag) return false;
  const removed = await getDb()
    .delete(itemTags)
    .where(
      sql`${itemTags.itemId} = ${itemId} AND ${itemTags.tagId} IN (
        SELECT id FROM ${tags} WHERE user_id = ${userId} AND name = ${tag}
      )`,
    )
    .returning({ itemId: itemTags.itemId });
  return removed.length > 0;
}

/* ---------------------------------------------------------- collections */

export async function addToCollection(collectionId: string, itemId: string): Promise<void> {
  await getDb()
    .insert(collectionItems)
    .values({ collectionId, itemId })
    .onConflictDoNothing({ target: [collectionItems.collectionId, collectionItems.itemId] });
}

export async function removeFromCollection(collectionId: string, itemId: string): Promise<void> {
  await getDb()
    .delete(collectionItems)
    .where(and(eq(collectionItems.collectionId, collectionId), eq(collectionItems.itemId, itemId)));
}

/* --------------------------------------------------------------- search */

export interface SearchHit {
  id: string;
  score: number;
  keywordRank: number | null;
  semanticRank: number | null;
}

/**
 * Hybrid search: keyword hits from the tsvector index and semantic hits from
 * the HNSW vector index, fused with reciprocal rank fusion (k = 60). RRF is
 * used instead of adding raw scores because ts_rank and cosine distance are
 * not on comparable scales.
 */
export async function searchItemIds(
  userId: string,
  query: string,
  embedding: number[] | null,
  limit = 40,
): Promise<SearchHit[]> {
  const vectorLiteral = embedding && embedding.length ? `[${embedding.join(",")}]` : null;

  const rows = await rawRows<{ id: string; score: string; keyword_rank: string | null; semantic_rank: string | null }>(sql`
    WITH tsq AS (SELECT websearch_to_tsquery('english', ${query}) AS q),
    keyword AS (
      SELECT i.id, row_number() OVER (ORDER BY ts_rank(i.search_tsv, tsq.q) DESC) AS rank
      FROM items i, tsq
      WHERE i.user_id = ${userId}::uuid AND i.search_tsv @@ tsq.q
      LIMIT 100
    ),
    semantic AS (
      SELECT i.id, row_number() OVER (ORDER BY i.embedding <=> ${vectorLiteral}::vector) AS rank
      FROM items i
      WHERE i.user_id = ${userId}::uuid
        AND i.embedding IS NOT NULL
        AND ${vectorLiteral}::vector IS NOT NULL
      ORDER BY i.embedding <=> ${vectorLiteral}::vector
      LIMIT 100
    )
    SELECT i.id,
           (coalesce(1.0 / (60 + keyword.rank), 0) + coalesce(1.0 / (60 + semantic.rank), 0))::text AS score,
           keyword.rank::text AS keyword_rank,
           semantic.rank::text AS semantic_rank
    FROM items i
    LEFT JOIN keyword ON keyword.id = i.id
    LEFT JOIN semantic ON semantic.id = i.id
    WHERE keyword.id IS NOT NULL OR semantic.id IS NOT NULL
    ORDER BY score DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    score: Number(row.score),
    keywordRank: row.keyword_rank ? Number(row.keyword_rank) : null,
    semanticRank: row.semantic_rank ? Number(row.semantic_rank) : null,
  }));
}

/** Nearest neighbours of one item, for "related" in the detail view. */
export async function relatedItems(userId: string, itemId: string, limit = 8): Promise<SearchHit[]> {
  const rows = await rawRows<{ id: string; score: string }>(sql`
    WITH source AS (SELECT embedding FROM items WHERE id = ${itemId}::uuid AND user_id = ${userId}::uuid)
    SELECT i.id, (1 - (i.embedding <=> source.embedding))::text AS score
    FROM items i, source
    WHERE i.user_id = ${userId}::uuid
      AND i.id <> ${itemId}::uuid
      AND i.embedding IS NOT NULL
      AND source.embedding IS NOT NULL
    ORDER BY i.embedding <=> source.embedding
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ id: row.id, score: Number(row.score), keywordRank: null, semanticRank: null }));
}

/** Items changed since a timestamp, for the live event stream. */
export async function itemsUpdatedSince(userId: string, since: Date, limit = 60): Promise<ItemRecord[]> {
  const rows = await getDb()
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), sql`${items.updatedAt} > ${since}`))
    .orderBy(asc(items.updatedAt))
    .limit(limit);
  return attachRelations(userId, rows);
}

/** Items that still need work, used by the worker's sweep. */
export async function stalePendingItems(limit = 25): Promise<Array<{ id: string; userId: string; url: string }>> {
  const rows = await rawGet();
  return rows.slice(0, limit);
}

async function rawGet(): Promise<Array<{ id: string; userId: string; url: string }>> {
  const result = await rawRows<{ id: string; user_id: string; url: string }>(sql`
    SELECT id, user_id, url FROM items
    WHERE status = 'pending' AND added_at < now() - interval '10 minutes'
    ORDER BY added_at ASC
    LIMIT 25
  `);
  return result.map((r) => ({ id: r.id, userId: r.user_id, url: r.url }));
}
