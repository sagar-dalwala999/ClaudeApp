# Looks browser extension

Optional, but it is the answer to two problems no server can solve: reading a
page that only exists for a signed-in browser, and reading a post whose
substance is behind a link nobody followed.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick this `extension/` directory.
4. In your Looks app, open **System → Ingest tokens** and create one.
5. Click the extension icon → **Connection** → paste your server URL
   (`https://looks.example.com` or `http://localhost:3000`) and the token →
   **Save & test**.

`Ctrl/⌘ + Shift + L` opens the popup from anywhere.

## The button on every post

On **X, Instagram, Reddit and Threads** a small picture-frame button appears in
each post's action row, next to reply and like. It is quiet until you hover.
Click it and that one post is saved — not the page, not the timeline, the post.

| What it reads | Where it comes from |
| --- | --- |
| Permalink | the anchor around the timestamp, so the item files under the post, not the feed |
| Author and handle | the post's own name block |
| Text | as rendered, with the separators and "Show more" furniture dropped |
| Pictures | every one in the post, upgraded to full size — X serves `name=small` to a timeline |
| Video | the source when the player exposes one, and always the poster frame |
| Links | with the destination the page displays for them |
| Quoted post | its author and text, kept separate from the post's own |
| Counts | replies, reposts, likes, as the feed abbreviates them |

### Why the links matter

A product launch on X is often one line and a `t.co`. Resolve that
server-side and the archive gets the one line; everything that says what the
thing *is* sits behind a shortener the resolver never follows.

Your browser is already past that problem. X renders the link as
`apps.apple.com/us/app/…` and puts the full destination in the anchor's
`title`. The capture keeps both, writes them into the item's body text, and
shows them on the item as **Links in this post** — so the summariser, the
search index and you all see where it goes.

Turn the buttons off any time from the popup. The toggle takes effect in open
tabs immediately; a tab opened before you installed the extension needs one
reload.

## The button in the toolbar

For everything else: it reads the page in front of you — Open Graph tags,
platform-specific DOM, visible prose, and the largest rendered image.

## How a capture travels

| Step | Where | Why |
| --- | --- | --- |
| Read the post, or the page | content script | it sees what you see |
| Fetch the image bytes | service worker | with host permissions this succeeds *with your cookies*, which a server-side fetch cannot |
| `POST /api/ingest` with an ingest token | service worker | one code path shared with Shortcuts and `curl` |

The request outlives the thing that started it: scroll the post away, or close
the popup, and the save still finishes. Then the server does the rest — dedupe
by platform identity, WebP variants, the AI summary and tags.

## Permissions, honestly

- `host_permissions` for x.com, instagram.com, reddit.com and threads.com —
  where the per-post buttons run. Nothing is sent anywhere until you click one.
- `activeTab`, `scripting` — inject the page collector when you press the
  toolbar button. Nothing runs in the background on other tabs.
- `storage` — keep your server URL, token and the button toggle locally.
- `optional_host_permissions: <all_urls>` — needed to fetch image bytes from
  platform CDNs. It is broad by nature; grant it only for the sites you care
  about, or skip it and let the server fetch what it can reach.

The token is stored in `chrome.storage.local` on your machine and can be
revoked from **System → Ingest tokens** at any time.

## When a platform changes its markup

Every selector lives in `platforms.js`, one adapter per platform, so a
reshuffle is a small fix in one place. The pure parts are in `lib.js` and the
adapters are covered by `tests/unit/postExtract.test.ts`, which runs these
exact files against a rendered DOM — start there.

## Capturing from a phone

The same endpoint takes form data, so an iOS Shortcut works too:

```
POST https://looks.example.com/api/ingest
Authorization: Bearer lk_…
Content-Type: multipart/form-data
  url=<Shared URL>
  title=<Name>
  image=<optional screenshot>
```

Or use the PWA share target in `manifest.webmanifest`.
