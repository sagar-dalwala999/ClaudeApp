# Looks

A personal link archive that behaves like a librarian with good taste.

You paste a URL — or fire it in from the browser extension, an iOS Shortcut, or
`curl`. Looks fetches the page, works out what it actually is, writes a factual
title and a three-to-five sentence summary, tags it with a controlled
vocabulary, downloads the picture, and files it into a searchable wall you can
browse by collection, tag, author or meaning.

Everything is stored in your own Postgres. The AI step is optional: without a
key you still get every link, its real title, its readable text and its image.

```
paste ─▶ normalize ─▶ dedupe ─▶ ┌─ resolve (per-platform chain) ─┐ ─▶ media ─▶ enrich ─▶ wall
   ▲                            └─ or your own capture ─────────┘
   └── extension · Shortcut · curl
```

---

## What it is, and what it is not

**It is** a self-hosted archive with a real database, a job worker, an
OpenAI-compatible AI provider, hybrid search, an Obsidian export and an
operational settings screen. Nothing is mocked; every card came from a link.

**It is not** a scraper farm. Reads are polite by construction: a per-host token
bucket, `robots.txt` for generic fetches, byte and time ceilings, an honest
`User-Agent`, and a documented escape hatch (the extension) for the walled
gardens that no server can or should reach.

---

## The interface

The front end is the part worth keeping: it was built for a canvas archive and
still is. `<canvas>` masonry wall (virtualised, hover, keyboard navigation),
force-directed graph of tags and authors, per-collection thumbnail strips, a
detail panel, a ⌘K palette, and a status bar whose every hint is clickable.

| Keys | Action |
| --- | --- |
| `⌘V` | Save a link (opens the capture bar) |
| `⌘K` / `F` | Search the whole archive |
| `⌃S` | Hide / show the sidebar |
| `⇧⌘N` | New collection |
| `⌥⇧ ↑ ↓` | Switch collection |
| `↑ ↓ ← →` | Navigate cards |
| `Enter` / `Space` | Open the selected card |
| `⌘F` | Filter within the current collection |
| `⌘,` | Settings |
| `G` | Toggle grid / graph view |
| `S` | Back to grid |
| `Esc` | Close overlays, clear selection |
| `← →` | Previous / next item, while a card is open |

`⌘` is `Ctrl` on Linux and Windows.

---

## Quick start

Requirements: **Node 22+**, **Postgres 14+ with pgvector** (the compose file
ships `pgvector/pgvector:pg17`).

```bash
git clone <this repo> && cd looks
cp .env.example .env          # set DATABASE_URL and AUTH_SECRET at minimum

docker compose up -d postgres # database only; the app runs on the host
npm install
npm run db:migrate            # creates the schema, and the owner account if
                              # OWNER_EMAIL / OWNER_PASSWORD are set in .env

npm run dev                   # terminal 1 — http://localhost:3000
npm run worker                # terminal 2 — resolve / media / enrich jobs
```

Sign in at <http://localhost:3000/login>. No account? Either set
`OWNER_EMAIL` + `OWNER_PASSWORD` before migrating, or create one afterwards:

```bash
npm run user:create -- you@example.com          # prompts via stdin, or:
printf '%s' "$PASSWORD" | npm run user:create -- you@example.com
npm run user:create -- you@example.com --reset  # change the password later
```

`AUTH_SECRET` must be at least 32 characters: `openssl rand -hex 32`.

### Save your first link

Paste a URL anywhere in the app (`⌘V`) and it appears as a placeholder card
immediately. The worker fills in the real title, image and summary a moment
later, and the wall updates itself over server-sent events — no refresh, no
polling.

---

## How a link becomes a card

1. **Normalize** (`src/server/normalize/`) — pull the URL out of whatever was
   pasted, strip tracking parameters, fold host aliases (`twitter.com` →
   `x.com`, `old.reddit.com` → `reddit.com`), and derive an **identity key**.
   This is the dedupe guarantee: `x.com/a/status/123`, `twitter.com/a/status/123?s=20`
   and `x.com/i/web/status/123` are all `x:123`, so they are one card forever.
2. **Dedupe** — the insert is `ON CONFLICT (user_id, identity_key)`. A repeat
   paste returns the existing card and says so; it is not an error.
3. **Resolve** — the platform's adapters run in priority order, each with its
   own timeout and rate limit, merging into one record. Field conflicts are
   settled by priority, so a good title beats a mediocre one. Every attempt is
   recorded in `resolver_events`, which is what the settings screen charts.
4. **Media** — the best image is fetched through the same safe-fetch path,
   transcoded to WebP at card and full sizes (`sharp`), and stored under
   `MEDIA_DIR` or an S3-compatible bucket. The bytes never pass through the
   browser directly.
5. **Enrich** — your configured OpenAI-compatible provider writes the title, summary, type and 3–6 tags.
   It also drafts the note — why the thing is worth keeping, where it belongs in
   the archive, what to do with it — and only while the note is still that
   draft: your first edit there ends the AI's interest in it. Tags
   are reconciled against the ones you already have (stemming, alias
   table), so the vocabulary converges instead of fragmenting. Every call is
   priced into the `enrichments` row it produced, which is what the settings
   screen adds up.
6. **Index** — `search_tsv` (generated `tsvector`) plus a pgvector embedding,
   fused with reciprocal rank fusion for `⌘K`.

### The resolver chain

| Priority | Resolver | Covers | What it costs |
| --- | --- | --- | --- |
| 10 | `x-scrape-do` | X text, author, date, media | paid; round-robin `SCRAPE_DO_TOKENS` |
| 20 | `x-syndication` | X media, author, full text fallback | free, **undocumented** — disable with `ENABLE_X_SYNDICATION=false` |
| 30 | `x-oembed` | X post text and author fallback | free, documented, no auth |
| 40 | `reddit-scrape-do` | title, body, author, gallery, metadata | paid residential request (`super=true`) |
| 50 | `reddit-oauth` | official API fallback | free script app, 100 QPM |
| 60 | `instagram-oembed` | official embed HTML | tokenless since June 2026, **no thumbnail or caption** |
| 70 | `github-api` | repo/issue/PR metadata, social image | free, 60/hr (5,000 with `GITHUB_TOKEN`) |
| 80 | `youtube-oembed` | title, channel, poster frame | free |
| 90 | `open-graph` | any page: Open Graph, Twitter cards, JSON-LD, readable prose | free |
| 100 | `url-fallback` | a slug-derived title | free, always succeeds |

Adapters that fail five times in a row are stood down automatically and retried
on the next item, so one dead endpoint degrades one platform instead of the
whole pipeline. `ENABLE_LIVE_RESOLVERS=false` turns the network off entirely
(that is what the unit tests run with).

### Platform reality, honestly

- **GitHub, YouTube, arXiv, blogs, docs** — excellent, free, no configuration.
- **Reddit and X** — when `SCRAPE_DO_TOKENS` is configured, the worker fetches
  their public HTML through Scrape.do before trying the free fallbacks. Tokens
  are comma-separated and each request starts on the next token. A Scrape.do
  `401` or `429` advances through the rest of the pool; target failures and
  transient `502` responses do not burn every token. Reddit uses the paid
  residential `super=true` mode to avoid soft-blocked 200 responses.
- **Reddit fallback** — register a *script* app at
  <https://www.reddit.com/prefs/apps> and set `REDDIT_CLIENT_ID` /
  `REDDIT_CLIENT_SECRET` for the official free API fallback.
- **X fallbacks** — tokenless oEmbed and the unsupported syndication endpoint
  remain available when Scrape.do is absent or fails.
- **Instagram** — Meta dropped the token requirement from its oEmbed APIs in
  June 2026, so an official embed works with no app review. After the oEmbed
  Read migration it returns no thumbnail, author or caption, so an Instagram
  card is link-and-embed only **unless** you capture it with the extension.
- **Anything behind a login** — the extension. It reads the page you are
  already signed into, with your cookies, from your browser.
- **A post whose substance is behind a shortener** — the extension's per-post
  button, which keeps the destination the page displays next to the link.

---

## The extension

`extension/` is a Manifest V3 extension, and it captures two ways.

**A button on every post.** On X, Instagram, Reddit and Threads it puts a small
picture-frame button in each post's action row. Clicking it saves *that post*:
its permalink, author and handle, the text as rendered, every picture and video
in it, who it quotes, and its outbound links — with the destinations the page
had already resolved.

That last part is why the button exists. A launch post that is one line plus a
`t.co` resolves server-side to one line: the substance is behind a shortener
nobody followed. In the page, the reader can see `apps.apple.com/us/app/…`
right there in the markup, so the capture keeps it and writes it into the
item's body, where search and the summariser can both reach it.

**A button in the toolbar**, for anything else: it reads the page in front of
you (Open Graph tags, platform DOM, visible prose, the largest rendered image).

Either way the service worker fetches the image bytes with your session — the
one thing a server-side fetch can never do for a logged-in page — and posts
everything to `/api/ingest` with an ingest token. Install instructions in
[`extension/README.md`](extension/README.md).

Ingest tokens are created in **Settings → Ingest tokens** or with
`npm run tokens:create -- "Arc extension"`. They are stored hashed and shown
exactly once; revoke them from the same screen.

## Capture from a phone

Install the archive (Add to Home Screen — a passthrough service worker makes it
installable, and nothing is cached behind your back) and **Looks** appears in
the share sheet of every app on the phone. Sharing a link posts it to `/share`,
which files it and drops you back on the wall with the new card on top.

On iOS, where the share sheet needs a Shortcut, the same endpoint accepts
`multipart/form-data`:

```bash
curl -X POST https://looks.example.com/api/ingest \
  -H "Authorization: Bearer lk_…" \
  -F url="https://www.instagram.com/p/Cxyz123/" \
  -F title="From my phone" \
  -F image=@screenshot.png
```

---

## Configuration

Every variable is validated at boot by `src/server/env.ts`; a bad value is a
clear error, not a mystery at request time. `.env.example` is the annotated
reference. The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | required; needs pgvector |
| `AUTH_SECRET` | — | required; 32+ chars |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | — | optional bootstrap during migration |
| `AI_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible API base URL |
| `AI_API_KEY` | — | bearer token; optional for unauthenticated local providers |
| `AI_USER_AGENT` | fetch default | sent as `user-agent`; required by gateways that fingerprint the client |
| `AI_CHAT_MODEL` | — | enables enrichment when set |
| `AI_EMBED_MODEL` | — | optional; blank keeps search keyword-only |
| `AI_JSON_MODE` | `auto` | `auto`, `json-schema`, `json-object`, or `prompt` |
| `AI_MAX_TOKENS_PARAM` | `max_tokens` | parameter name used when a ceiling is set |
| `AI_MAX_OUTPUT_TOKENS` | unset | ceiling on one completion; unset sends no limit |
| `STORAGE_DRIVER` | `local` | `local` or `s3` |
| `MEDIA_DIR` | `./data/media` | shared by web and worker |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | R2, MinIO, AWS |
| `SCRAPE_DO_TOKENS` | — | comma-separated pool used round-robin for X and Reddit |
| `ENABLE_X_SYNDICATION` | `true` | the undocumented X endpoint |
| `ENABLE_LIVE_RESOLVERS` | `true` | master switch for outbound traffic |
| `REDDIT_CLIENT_ID` / `_SECRET` | — | free 100 QPM |
| `GITHUB_TOKEN` | — | 60/hr → 5,000/hr |
| `FETCH_USER_AGENT` | `LooksBot/0.2 (…)` | identify yourself |
| `FETCH_TIMEOUT_MS` / `FETCH_MAX_BYTES` | `15000` / `5000000` | ceilings |
| `OBSIDIAN_VAULT_PATH` | — | enables vault mirroring |
| `EXTENSION_ORIGINS` | — | CORS allow-list for extension captures |

---

## API

Everything requires the session cookie except `/api/ingest` (an ingest token
or the cookie) and `/api/health`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/items` | paged list: `collectionId`, `tag`, `type`, `status`, `favorite`, `sort`, `cursor`, `limit` |
| `POST` | `/api/items` | save a link; returns `{item, created, duplicate}` |
| `GET` `PATCH` `DELETE` | `/api/items/[id]` | one item; patch `title`, `summary`, `note`, `tags`, `type`, `status`, `favorite`, `collectionId`. A hand-edited title is marked `source: "manual"` so the AI never overwrites it |
| `POST` | `/api/items/[id]/retry` | re-run the pipeline; `{"force":true}` ignores the unchanged-content guard and re-summarises |
| `GET` | `/api/search?q=` | hybrid keyword + semantic, reports `mode` |
| `GET` `POST` | `/api/collections`, `/api/collections/[id]`, `/[id]/items` | collections and membership |
| `GET` | `/api/tags` | tag counts |
| `GET` `POST` `DELETE` | `/api/tokens` | ingest tokens (raw value returned once) |
| `POST` | `/api/ingest` | the capture endpoint (token auth) |
| `GET` | `/api/events` | server-sent events; the wall updates itself |
| `GET` | `/api/img?key=&v=card\|full` | stored media, with an immutable cache header |
| `GET` `POST` | `/api/export` | markdown vault as JSON, one file as a download, or mirror to disk |
| `GET` | `/api/system` | counts, resolver health, queue depth, AI spend |
| `GET` | `/api/health` | liveness for your uptime check |
| `POST` | `/share` | the PWA share target: files a shared link and redirects to the wall |

---

## Markdown / Obsidian export

The archive is not a roach motel. `INDEX.md` holds every entry newest first,
and one `YYYY-MM-DD.md` per day holds the session snapshot — the same field
order the original curator brief specified, so an existing vault workflow keeps
working.

```bash
npm run export:markdown                    # to OBSIDIAN_VAULT_PATH, or ./data/vault
npm run export:markdown -- /path/to/vault  # explicit target
```

Or from the app: **Settings → Markdown export** (preview, download, or queue a
mirror into the configured vault).

---

## Operations

- **Worker** — `npm run worker` runs the pg-boss queues (`resolve`, `media`,
  `enrich`, `maintenance`, `exportMarkdown`). It is required: nothing is fetched
  without it, and the wall will show placeholder cards until it runs.
- **Health** — `GET /api/health` for uptime checks; **Settings** for the fuller
  picture: queue depth, per-resolver hit rate, p50 latency, last error, AI spend
  today.
- **Backups** — the database and `MEDIA_DIR` are the whole state; everything
  else can be rebuilt. `npm run export:markdown` is a good second copy.
- **Cost** — every AI call is priced into the `enrichments` row it produced, so
  the settings screen can total the day. Nothing is capped: a page the AI could
  not read still ends as a captured, readable card, with the reason recorded.

Deployment (compose stack, reverse proxy, TLS, S3, scaling, upgrades) is in
[`docs/deployment.md`](docs/deployment.md).

---

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest — pure unit tests, no network, no database
npm run test:live   # opt-in: the resolver chain against the real internet
npm run build       # production build
```

The unit suite covers the parts where correctness is a promise rather than a
preference: URL normalization and identity keys (the dedupe guarantee), tag
normalization, HTML/meta parsing, the capture payload, the markdown format,
rate limits and the login throttle.

`npm run test:live` is separate on purpose. It fetches real pages, so a red run
there means "a platform changed something", not "the build is broken" — which
is the question you actually have when an adapter quietly stops returning
media. It is not part of the default run or of CI.

```
src/
  app/                 routes: page, login, settings, share, api/*,
                       manifest.webmanifest (with its share target)
  components/          Archive, GridCanvas, GraphCanvas, Sidebar*, ItemDetail,
                       SearchPalette, CaptureBar, SystemPanel, StatusBar…
  lib/                 client item shape, api client, art (thumbnails),
                       artStyles (procedural placeholders), layout, settings
  server/
    auth/              scrypt passwords, sessions, ingest tokens, guards
    db/                drizzle schema, migrations, typed queries
    enrich/            OpenAI-compatible provider, prompts, tag reconciliation
    export/            markdown vault
    jobs/              pg-boss queue, worker, handlers
    limits/            rate limits and AI cost accounting
    media/             safe fetch, transcode, local/S3 storage
    net/               bounded HTTP with redirect + size limits
    normalize/         URL cleaning and platform identity
    resolve/           the resolver chain, one file per platform
    text/              HTML, tags, slugs, size caps
drizzle/               SQL migrations, applied in order
extension/             MV3 capture extension
scripts/               create-user, create-token, export-markdown
tests/unit/            vitest
```

## Known limits

- X and Reddit fall back to their existing free adapters when
  `SCRAPE_DO_TOKENS` is empty. Scrape.do usage is paid, and Reddit's required
  residential mode costs more than a basic request.
- `x-syndication` is undocumented by definition; it is only a fallback when
  Scrape.do is unavailable or fails.
- Rate limiting and Scrape.do token rotation are per worker process. Multiple
  workers do not coordinate their starting token or request rate.
- Keyword search uses the Postgres `english` configuration, so stemming is
  English-centric. Other languages are still findable through the embedding
  half of the search rather than through `tsquery`.
