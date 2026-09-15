-- Looks: initial schema.
--
-- Applied by `npm run db:migrate`. Each file runs once, inside a transaction,
-- and its checksum is recorded in schema_migrations — an edited file that has
-- already been applied is a hard error rather than a silent no-op.

CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------------- auth

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Case-insensitive uniqueness: "Me@x.com" and "me@x.com" are one account.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the bearer token; the raw token only exists in the cookie.
  token_hash   text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS ingest_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ingest_tokens_token_hash_key ON ingest_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ingest_tokens_user_idx ON ingest_tokens (user_id);

-- ------------------------------------------------------------------ items

CREATE TABLE IF NOT EXISTS items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  url           text NOT NULL,
  canonical_url text NOT NULL,
  identity_key  text NOT NULL,
  platform      text NOT NULL DEFAULT 'other',
  type          text NOT NULL DEFAULT 'other',
  title         text,
  summary       text,
  author        text,
  author_handle text,
  site_name     text,
  language      text,
  published_at  timestamptz,
  status        text NOT NULL DEFAULT 'pending',
  source        text,
  note          text,
  body_text     text,
  content_hash  text,
  ai            boolean NOT NULL DEFAULT false,
  favorite      boolean NOT NULL DEFAULT false,
  embedding     vector(1536),
  last_error    text,
  fetched_at    timestamptz,
  added_at      timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Kept in the table (rather than computed per query) so the GIN index below
  -- can serve keyword search.
  search_tsv    tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' ||
      coalesce(note, '') || ' ' || coalesce(author, '') || ' ' ||
      coalesce(site_name, '') || ' ' || coalesce(body_text, '')
    )
  ) STORED
);

-- One item per platform identity per user: the dedupe guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS items_user_identity_key ON items (user_id, identity_key);
CREATE INDEX IF NOT EXISTS items_user_added_idx ON items (user_id, added_at DESC);
CREATE INDEX IF NOT EXISTS items_user_status_idx ON items (user_id, status);
CREATE INDEX IF NOT EXISTS items_search_idx ON items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS items_embedding_idx ON items USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS item_content (
  item_id    uuid PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  text       text,
  html       text,
  og         jsonb,
  word_count integer NOT NULL DEFAULT 0,
  resolver   text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS item_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'image',
  remote_url  text,
  storage_key text,
  width       integer,
  height      integer,
  bytes       integer,
  placeholder text,
  alt         text,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_media_item_idx ON item_media (item_id, position);

-- ------------------------------------------------------- tags & collections

CREATE TABLE IF NOT EXISTS tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       text NOT NULL,
  label      text NOT NULL,
  embedding  vector(1536),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_user_name_key ON tags (user_id, name);
CREATE INDEX IF NOT EXISTS tags_embedding_idx ON tags USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS tag_aliases (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  alias   text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tag_aliases_user_alias_key ON tag_aliases (user_id, alias);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id    uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  source     text NOT NULL DEFAULT 'ai',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS item_tags_tag_idx ON item_tags (tag_id);

CREATE TABLE IF NOT EXISTS collections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS collections_user_slug_key ON collections (user_id, slug);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id uuid NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, item_id)
);

CREATE INDEX IF NOT EXISTS collection_items_item_idx ON collection_items (item_id);

-- ------------------------------------------------ audit & observability

CREATE TABLE IF NOT EXISTS enrichments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  model         text NOT NULL,
  prompt_version text NOT NULL,
  input_hash    text,
  response      jsonb,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  -- USD micros (1_000_000 = $1). Integer maths keeps the budget exact.
  cost_micros   integer NOT NULL DEFAULT 0,
  latency_ms    integer NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrichments_item_idx ON enrichments (item_id, kind);
CREATE INDEX IF NOT EXISTS enrichments_created_idx ON enrichments (created_at);

CREATE TABLE IF NOT EXISTS resolver_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid REFERENCES items (id) ON DELETE CASCADE,
  resolver    text NOT NULL,
  outcome     text NOT NULL,
  http_status integer,
  latency_ms  integer NOT NULL DEFAULT 0,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resolver_events_resolver_idx ON resolver_events (resolver, created_at DESC);
CREATE INDEX IF NOT EXISTS resolver_events_item_idx ON resolver_events (item_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
