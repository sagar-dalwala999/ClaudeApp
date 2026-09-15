/**
 * Drizzle table definitions.
 *
 * Declared columns are the ones application code reads and writes. Anything
 * Postgres generates (the `search_tsv` tsvector) or that only exists to be
 * queried with hand-written SQL lives in the migrations instead, so drizzle
 * never tries to write it.
 *
 * `drizzle/*.sql` is the source of truth for schema; these definitions must
 * match it. `npm run db:migrate` applies the SQL, `npm run typecheck` checks
 * these types against the query layer.
 */
import { boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/** pgvector column. Values are written as `[1,2,3]`. */
export const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dimensions})`,
    toDriver: (value: number[]) => `[${value.join(",")}]`,
    fromDriver: (value: string) =>
      value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(Number),
  })(name);

export const EMBEDDING_DIMENSIONS = 1536;

/* ------------------------------------------------------------------ auth */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the bearer token. The raw token only ever exists in a cookie. */
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("sessions_token_hash_key").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/** Long-lived tokens for the browser extension, iOS Shortcut and CLI. */
export const ingestTokens = pgTable(
  "ingest_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("ingest_tokens_token_hash_key").on(t.tokenHash), index("ingest_tokens_user_idx").on(t.userId)],
);

/* ----------------------------------------------------------------- items */

export const ITEM_STATUSES = ["pending", "ready", "unread", "failed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_TYPES = ["github", "article", "x-post", "tool", "video", "paper", "other"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    /** Stable per-platform identity; the dedupe key together with user_id. */
    identityKey: text("identity_key").notNull(),
    platform: text("platform").notNull().default("other"),
    type: text("type").notNull().default("other"),
    title: text("title"),
    summary: text("summary"),
    author: text("author"),
    authorHandle: text("author_handle"),
    siteName: text("site_name"),
    language: text("language"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    /** Which adapter produced the data: x-syndication, open-graph, extension… */
    source: text("source"),
    /** User's own note. Never overwritten by enrichment. */
    note: text("note"),
    /** Excerpt fed to full-text search and the embedder. */
    bodyText: text("body_text"),
    /** sha256 of the text that was enriched; unchanged hash skips re-enrichment. */
    contentHash: text("content_hash"),
    /** True when the title/summary came from the language model. */
    ai: boolean("ai").notNull().default(false),
    favorite: boolean("favorite").notNull().default(false),
    embedding: vector("embedding", EMBEDDING_DIMENSIONS),
    lastError: text("last_error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("items_user_identity_key").on(t.userId, t.identityKey),
    index("items_user_added_idx").on(t.userId, t.addedAt),
    index("items_user_status_idx").on(t.userId, t.status),
  ],
);

/** Full payloads kept off `items` so list queries stay cheap. */
export const itemContent = pgTable("item_content", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  text: text("text"),
  html: text("html"),
  og: jsonb("og"),
  wordCount: integer("word_count").notNull().default(0),
  resolver: text("resolver"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const itemMedia = pgTable(
  "item_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("image"),
    remoteUrl: text("remote_url"),
    /** Key inside the storage driver; null while the download is pending. */
    storageKey: text("storage_key"),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    /** Dominant colour, `#rrggbb`, so the grid can paint before the image lands. */
    placeholder: text("placeholder"),
    alt: text("alt"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("item_media_item_idx").on(t.itemId, t.position)],
);

/* ------------------------------------------------------ tags & collections */

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Normalised slug used for matching: lowercase, hyphenated, no `#`. */
    name: text("name").notNull(),
    /** Human-facing form, usually identical to `name`. */
    label: text("label").notNull(),
    embedding: vector("embedding", EMBEDDING_DIMENSIONS),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_user_name_key").on(t.userId, t.name)],
);

export const tagAliases = pgTable(
  "tag_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
  },
  (t) => [uniqueIndex("tag_aliases_user_alias_key").on(t.userId, t.alias)],
);

export const itemTags = pgTable(
  "item_tags",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    /** "ai" tags can be replaced by re-enrichment; "user" tags never are. */
    source: text("source").notNull().default("ai"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] }), index("item_tags_tag_idx").on(t.tagId)],
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("collections_user_slug_key").on(t.userId, t.slug)],
);

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.itemId] }), index("collection_items_item_idx").on(t.itemId)],
);

/* ------------------------------------------------- audit & observability */

export const enrichments = pgTable(
  "enrichments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash"),
    response: jsonb("response"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** USD micros: 1_000_000 = $1. Integer maths, no float drift. */
    costMicros: integer("cost_micros").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enrichments_item_idx").on(t.itemId, t.kind), index("enrichments_created_idx").on(t.createdAt)],
);

export const resolverEvents = pgTable(
  "resolver_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "cascade" }),
    resolver: text("resolver").notNull(),
    outcome: text("outcome").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("resolver_events_resolver_idx").on(t.resolver, t.createdAt), index("resolver_events_item_idx").on(t.itemId)],
);

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Free-form UI + server preferences, validated by the API layer. */
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------- relations */

export const itemsRelations = relations(items, ({ one, many }) => ({
  content: one(itemContent, { fields: [items.id], references: [itemContent.itemId] }),
  media: many(itemMedia),
  tags: many(itemTags),
}));

export const itemMediaRelations = relations(itemMedia, ({ one }) => ({
  item: one(items, { fields: [itemMedia.itemId], references: [items.id] }),
}));
