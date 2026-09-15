# Deploying Looks

Three things run in production: the **web app**, the **worker**, and
**Postgres** (with pgvector). Media lives either on a shared volume or in an
S3-compatible bucket. That is the whole system.

```
        ┌──────────────┐
browser │ reverse proxy│──▶ web (Next.js, :3000)
        └──────────────┘        │            │
                                │            └──▶ Postgres (pgvector)
extension ──/api/ingest─────────┘                    ▲
                                                     │
                             worker (pg-boss) ───────┘
                                    │
                              media (volume or S3)
```

---

## 1. Compose stack (the supported path)

`docker-compose.yml` in the repository root builds the app once and runs it
twice — as `web` and as `worker` — against a `pgvector/pgvector:pg17` database.
Both containers share the `media` volume, so `STORAGE_DRIVER=local` works
without further setup.

```bash
cp .env.example .env
#   DATABASE_URL=postgres://looks:<password>@postgres:5432/looks
#   AUTH_SECRET=$(openssl rand -hex 32)
#   OWNER_EMAIL / OWNER_PASSWORD   (bootstrap, then remove)
#   AI_CHAT_MODEL / AI_BASE_URL    (optional OpenAI-compatible provider)
$EDITOR .env

docker compose up -d --build
docker compose logs -f worker
```

The worker's start command is `npm run db:migrate && npm run worker`, so
migrations apply on every deploy and the worker owns them. The web container
only serves traffic. If you run the app without compose, migrate explicitly
first:

```bash
npm run db:migrate
```

Migrations are checksummed: editing an applied file is a hard error rather than
a silent no-op, so to change the schema, add a new file to `drizzle/` (numbered
higher) and redeploy.

### Behind a reverse proxy

Terminate TLS at the proxy and forward to `127.0.0.1:3000`. Two things need
attention:

- **Server-sent events** (`/api/events`) must not be buffered. Nginx needs
  `proxy_buffering off;`, Caddy needs nothing, Cloudflare proxies are fine.
- **Long uploads** are not a thing here (captures are capped at 8 MB), but the
  proxy should still allow a 30-second response header timeout.

Caddy, as the whole config:

```caddy
looks.example.com {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
```

Put the app behind authentication you control if the domain is public — the app
has its own login, but the settings screen reveals queue and resolver internals
to anyone who gets in.

---

## 2. Postgres

- **Version**: 14 or newer, with the `vector` extension available. The compose
  image is `pgvector/pgvector:pg17`.
- **Extensions**: `CREATE EXTENSION IF NOT EXISTS vector;` runs in the first
  migration. `pgcrypto` is *not* required — ids use `gen_random_uuid()`, which
  is built in from PG 13.
- **Indexes**: the schema ships a GIN index on the generated `search_tsv`
  column and HNSW indexes on the embedding columns. On a fresh database they
  build instantly; the initial migration on a very large existing table may take
  a minute.
- **Connection count**: the web app pools 10 connections, the worker pools its
  own. Two web replicas plus the worker is comfortably under a default 100.

### Backups

The database and the media store are the entire state.

```bash
pg_dump --format=custom "$DATABASE_URL" > looks-$(date +%F).dump   # nightly
npm run export:markdown -- /backups/vault                           # human-readable copy
```

Restore with `pg_restore --clean --if-exists --dbname "$DATABASE_URL" file.dump`,
and copy the media directory (or bucket) back. Because the markdown export is a
plain-text archive of every entry, losing the database is an inconvenience
rather than a catastrophe.

---

## 3. Media storage

`STORAGE_DRIVER=local` (default) writes to `MEDIA_DIR`. In compose that is the
`media` volume mounted into both containers — **do not scale the web service
without it**, or half your images will 404.

`STORAGE_DRIVER=s3` removes the shared-volume requirement and is the right
choice for more than one host. Works with Cloudflare R2, MinIO, Backblaze B2 and
AWS:

```env
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=looks-media
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

Bytes are uploaded and served by the app itself (`/api/img`), signed with SigV4
through `aws4fetch`, so the bucket can stay private. Reads are cached
immutably, because a media key never changes content.

---

## 4. Scaling and resource notes

- **Worker**: `sharp` transcoding is the memory-hungry part. The compose service
  caps it at 2 GB with `--max-old-space-size=1536`. Start with one; add a second
  only if the queue backs up during bulk imports, and remember that rate limits
  are per process — two workers means twice the request rate against Reddit, X
  and Instagram.
- **Web**: stateless apart from the media volume; scales horizontally behind the
  proxy. It does no fetching, so it stays cheap.
- **Postgres**: the largest table is `items` (prose) plus `resolver_events`
  (telemetry). The `maintenance` queue prunes old resolver events; if you skip
  the worker entirely, prune it yourself.

---

## 5. Upgrades

```bash
git pull
docker compose build
docker compose up -d
```

The worker migrates before it starts, so the database is always ahead of the
old code, never behind. If a migration fails the worker exits and the queue
simply stops; the web app keeps serving reads.

Rollback means checking out the previous commit and rebuilding. Migrations are
forward-only by design: make them additive (new columns nullable, no in-place
renames) and a rollback is safe.

---

## 6. Security checklist

- [ ] `AUTH_SECRET` is 32+ random characters and not reused elsewhere.
- [ ] `OWNER_PASSWORD` is removed from `.env` after the first migration.
- [ ] Postgres is not published to the internet (the compose file binds it to
      `127.0.0.1` — keep it that way, or drop the `ports` block).
- [ ] Ingest tokens are per-device and revoked in **Settings** when a device is
      lost; they grant write access to your archive.
- [ ] `EXTENSION_ORIGINS` lists only the origins allowed to POST captures
      cross-origin, if you use the extension from a different origin.
- [ ] `/settings` is only reachable by someone you would trust with your
      archive, or is behind a second layer of auth at the proxy.
- [ ] Media is served from your own origin, never hotlinked from a platform CDN,
      so a hostile image cannot track readers.

## 7. Monitoring

- `/api/health` probes the database and answers 200, or 503 when it cannot
  reach it; it also reports whether AI and the live resolvers are configured.
  The Dockerfile already uses it as its healthcheck. Point your uptime monitor
  at it too.
- **Settings** is the operational dashboard: queue depth per queue,
  per-resolver hit rate, p50 latency and last error over the past week, AI spend
  against the daily cap, and whether each adapter has the configuration it
  needs.
- Resolvers that fail five times in a row are stood down automatically and
  retried later. If a row stays disabled, that platform changed its rules — the
  fix is one file in `src/server/resolve/`.
- Logs are plain lines on stdout (`[resolve]`, `[media]`, `[enrich]`,
  `[events]`, `[export]`). Ship them wherever you like; nothing parses them
  internally.
