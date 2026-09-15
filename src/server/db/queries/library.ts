/**
 * Collections, tags, statistics and resolver telemetry.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rawRows } from "../client";
import { collectionItems, collections, itemTags, items, resolverEvents, tags } from "../schema";
import { slugify } from "../../text/slug";

export interface CollectionSummary {
  id: string;
  name: string;
  slug: string;
  count: number;
  createdAt: string;
}

/**
 * Which items fill each collection's sidebar strip: the newest few per
 * collection, in one query rather than one round trip per row.
 */
export async function listCollectionPreviews(
  userId: string,
  perCollection = 12,
  maxCollections = 60,
): Promise<Array<{ collectionId: string; itemId: string }>> {
  const rows = await rawRows<{ collection_id: string; item_id: string }>(sql`
    SELECT collection_id, item_id FROM (
      SELECT ci.collection_id,
             ci.item_id,
             row_number() OVER (PARTITION BY ci.collection_id ORDER BY i.added_at DESC) AS rn
      FROM ${collectionItems} ci
      JOIN ${items} i ON i.id = ci.item_id
      WHERE i.user_id = ${userId}::uuid
    ) ranked
    WHERE rn <= ${perCollection}
    LIMIT ${perCollection * maxCollections}
  `);
  return rows.map((row) => ({ collectionId: row.collection_id, itemId: row.item_id }));
}

export interface TagSummary {
  name: string;
  label: string;
  count: number;
  hasEmbedding: boolean;
}

export async function listCollections(userId: string): Promise<CollectionSummary[]> {
  const rows = await rawRows<{ id: string; name: string; slug: string; count: string; created_at: Date }>(sql`
    SELECT c.id, c.name, c.slug, c.created_at,
           count(ci.item_id)::text AS count
    FROM ${collections} c
    LEFT JOIN ${collectionItems} ci ON ci.collection_id = c.id
    WHERE c.user_id = ${userId}::uuid
    GROUP BY c.id, c.name, c.slug, c.created_at, c.position
    ORDER BY c.position ASC, lower(c.name) ASC
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    count: Number(r.count),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export async function createCollection(userId: string, name: string): Promise<CollectionSummary> {
  const trimmed = name.trim().slice(0, 120);
  const db = getDb();
  const [maxPosition] = await db
    .select({ value: sql<number>`coalesce(max(${collections.position}), 0)` })
    .from(collections)
    .where(eq(collections.userId, userId));
  const base = slugify(trimmed);

  // Slugs are unique per user; suffix until we find a free one.
  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const inserted = await db
      .insert(collections)
      .values({ userId, name: trimmed, slug, position: Number(maxPosition?.value ?? 0) + 1 })
      .onConflictDoNothing({ target: [collections.userId, collections.slug] })
      .returning();
    if (inserted.length) {
      return { id: inserted[0].id, name: inserted[0].name, slug: inserted[0].slug, count: 0, createdAt: inserted[0].createdAt.toISOString() };
    }
  }
  throw new Error("Could not find a free slug for that collection name");
}

export async function renameCollection(userId: string, id: string, name: string): Promise<boolean> {
  const updated = await getDb()
    .update(collections)
    .set({ name: name.trim().slice(0, 120) })
    .where(and(eq(collections.userId, userId), eq(collections.id, id)))
    .returning({ id: collections.id });
  return updated.length > 0;
}

export async function deleteCollection(userId: string, id: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(collections)
    .where(and(eq(collections.userId, userId), eq(collections.id, id)))
    .returning({ id: collections.id });
  return deleted.length > 0;
}

export async function listTags(userId: string, limit = 400): Promise<TagSummary[]> {
  const rows = await rawRows<{ name: string; label: string; count: string; embedded: boolean }>(sql`
    SELECT t.name, t.label, count(it.item_id)::text AS count, (t.embedding IS NOT NULL) AS embedded
    FROM ${tags} t
    LEFT JOIN ${itemTags} it ON it.tag_id = t.id
    WHERE t.user_id = ${userId}::uuid
    GROUP BY t.id, t.name, t.label, t.embedding
    HAVING count(it.item_id) > 0
    ORDER BY count(it.item_id) DESC, t.name ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ name: r.name, label: r.label, count: Number(r.count), hasEmbedding: Boolean(r.embedded) }));
}

/** Tags with their vectors, for reconciliation against new candidates. */
export async function tagVocabulary(userId: string, limit = 400): Promise<Array<{ id: string; name: string; embedding: number[] | null }>> {
  const rows = await rawRows<{ id: string; name: string; embedding: string | null }>(sql`
    SELECT id, name, embedding::text AS embedding
    FROM ${tags}
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    embedding: row.embedding
      ? row.embedding
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((n) => Number(n))
      : null,
  }));
}

export async function tagIdsFor(userId: string, names: string[]): Promise<Map<string, string>> {
  if (!names.length) return new Map();
  const rows = await getDb()
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(and(eq(tags.userId, userId), sql`${tags.name} = ANY(${names})`));
  return new Map(rows.map((r) => [r.name, r.id]));
}

export async function setTagEmbedding(tagId: string, embedding: number[]): Promise<void> {
  await rawRows(sql`UPDATE ${tags} SET embedding = ${`[${embedding.join(",")}]`}::vector WHERE id = ${tagId}::uuid`);
}

/* ------------------------------------------------------------- statistics */

export interface LibraryStats {
  items: number;
  ready: number;
  pending: number;
  failed: number;
  unread: number;
  enriched: number;
  mediaCount: number;
  mediaBytes: number;
  tags: number;
  collections: number;
  addedToday: number;
  addedThisWeek: number;
}

export async function libraryStats(userId: string): Promise<LibraryStats> {
  const rows = await rawRows<Record<string, string>>(sql`
    SELECT
      count(*)::text AS items,
      count(*) FILTER (WHERE status = 'ready')::text AS ready,
      count(*) FILTER (WHERE status = 'pending')::text AS pending,
      count(*) FILTER (WHERE status = 'failed')::text AS failed,
      count(*) FILTER (WHERE status = 'unread')::text AS unread,
      count(*) FILTER (WHERE ai)::text AS enriched,
      count(*) FILTER (WHERE added_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')::text AS added_today,
      count(*) FILTER (WHERE added_at >= now() - interval '7 days')::text AS added_this_week
    FROM ${items}
    WHERE user_id = ${userId}::uuid
  `);
  const mediaRows = await rawRows<{ count: string; bytes: string }>(sql`
    SELECT count(m.id)::text AS count, coalesce(sum(m.bytes), 0)::text AS bytes
    FROM item_media m
    JOIN ${items} i ON i.id = m.item_id
    WHERE i.user_id = ${userId}::uuid
  `);
  const [tagCount] = await rawRows<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM ${itemTags} it
    JOIN ${items} i ON i.id = it.item_id
    WHERE i.user_id = ${userId}::uuid
  `);
  const [collectionCount] = await rawRows<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM ${collections} WHERE user_id = ${userId}::uuid
  `);

  const row = rows[0] ?? {};
  const num = (value: string | undefined) => Number(value ?? 0);
  return {
    items: num(row.items),
    ready: num(row.ready),
    pending: num(row.pending),
    failed: num(row.failed),
    unread: num(row.unread),
    enriched: num(row.enriched),
    mediaCount: num(mediaRows[0]?.count),
    mediaBytes: num(mediaRows[0]?.bytes),
    tags: num(tagCount?.count),
    collections: num(collectionCount?.count),
    addedToday: num(row.added_today),
    addedThisWeek: num(row.added_this_week),
  };
}

/* ------------------------------------------------------- resolver health */

export interface ResolverHealthRow {
  resolver: string;
  attempts: number;
  hits: number;
  misses: number;
  errors: number;
  skipped: number;
  successRate: number;
  p50LatencyMs: number;
  lastError: string | null;
  lastSeenAt: string | null;
  consecutiveFailures: number;
  disabled: boolean;
}

/** A resolver is auto-disabled after this many consecutive failures. */
export const RESOLVER_FAILURE_THRESHOLD = 5;

export async function resolverHealth(windowHours = 168): Promise<ResolverHealthRow[]> {
  const rows = await rawRows<{
    resolver: string;
    attempts: string;
    hits: string;
    misses: string;
    errors: string;
    skipped: string;
    p50: string | null;
    last_error: string | null;
    last_seen: Date | null;
    consecutive_failures: string;
  }>(sql`
    WITH recent AS (
      SELECT resolver, outcome, error, latency_ms, created_at
      FROM ${resolverEvents}
      WHERE created_at > now() - (${windowHours}::text || ' hours')::interval
    ),
    streaks AS (
      SELECT resolver,
             count(*) FILTER (
               WHERE outcome = 'error'
                 AND created_at > coalesce(
                   (SELECT max(created_at) FROM recent r2 WHERE r2.resolver = recent.resolver AND r2.outcome <> 'error'),
                   '-infinity'::timestamptz
                 )
             )::text AS consecutive_failures
      FROM recent
      GROUP BY resolver
    )
    SELECT r.resolver,
           count(*)::text AS attempts,
           count(*) FILTER (WHERE r.outcome = 'hit')::text AS hits,
           count(*) FILTER (WHERE r.outcome = 'miss')::text AS misses,
           count(*) FILTER (WHERE r.outcome = 'error')::text AS errors,
           count(*) FILTER (WHERE r.outcome = 'skipped')::text AS skipped,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY r.latency_ms)::text AS p50,
           (array_agg(r.error ORDER BY r.created_at DESC) FILTER (WHERE r.outcome = 'error'))[1] AS last_error,
           max(r.created_at) AS last_seen,
           max(s.consecutive_failures)::text AS consecutive_failures
    FROM recent r
    LEFT JOIN streaks s ON s.resolver = r.resolver
    GROUP BY r.resolver
    ORDER BY r.resolver
  `);

  return rows.map((row) => {
    const attempts = Number(row.attempts);
    const hits = Number(row.hits);
    const errors = Number(row.errors);
    const consecutiveFailures = Number(row.consecutive_failures ?? 0);
    const decided = attempts - Number(row.skipped);
    return {
      resolver: row.resolver,
      attempts,
      hits,
      misses: Number(row.misses),
      errors,
      skipped: Number(row.skipped),
      successRate: decided > 0 ? hits / decided : 0,
      p50LatencyMs: Number(row.p50 ?? 0),
      lastError: row.last_error,
      lastSeenAt: row.last_seen ? new Date(row.last_seen).toISOString() : null,
      consecutiveFailures,
      disabled: consecutiveFailures >= RESOLVER_FAILURE_THRESHOLD,
    };
  });
}

/** Resolvers the worker should currently skip. */
export async function disabledResolvers(): Promise<Set<string>> {
  const rows = await resolverHealth(24).catch(() => []);
  return new Set(rows.filter((r) => r.disabled).map((r) => r.resolver));
}

export async function recentResolverEvents(limit = 50): Promise<
  Array<{ id: string; resolver: string; outcome: string; error: string | null; createdAt: string; itemId: string | null }>
> {
  const rows = await rawRows<{ id: string; resolver: string; outcome: string; error: string | null; created_at: Date; item_id: string | null }>(sql`
    SELECT id, resolver, outcome, error, created_at, item_id
    FROM ${resolverEvents}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    resolver: r.resolver,
    outcome: r.outcome,
    error: r.error,
    createdAt: new Date(r.created_at).toISOString(),
    itemId: r.item_id,
  }));
}
