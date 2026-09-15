# Looks browser extension

Optional, but it is the answer to the one problem no server can solve: reading a
page that only exists for a signed-in browser.

Instagram's oEmbed API (tokenless since June 2026) returns the embed HTML and
nothing visual — no thumbnail, no author, no caption. X's media lives behind an
undocumented endpoint. The extension sidesteps both by reading the page you
already have open and handing it to your archive.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick this `extension/` directory.
4. In your Looks app, open **System → Ingest tokens** and create one.
5. Click the extension icon → **Connection** → paste your server URL
   (`https://looks.example.com` or `http://localhost:3000`) and the token → **Save & test**.

`Ctrl/⌘ + Shift + L` opens the popup from anywhere.

## What it does

| Step | Where | Why |
| --- | --- | --- |
| Read the page (OG tags, platform-specific DOM, visible prose, largest rendered image) | content script | it sees what you see |
| Fetch the image bytes | service worker | with host permissions this succeeds *with your cookies*, which a server-side fetch cannot |
| `POST /api/ingest` with an ingest token | service worker | one code path shared with Shortcuts and `curl` |

Then the server does the rest: dedupe by platform identity, WebP variants, and
the AI summary and tags.

## Permissions, honestly

- `activeTab`, `scripting` — inject the collector into the page you are on when
  you press the button. Nothing runs in the background on other tabs.
- `storage` — keep your server URL and token locally.
- `optional_host_permissions: <all_urls>` — needed to fetch image bytes from
  platform CDNs. It is broad by nature; grant it only for the sites you care
  about, or skip the extension and accept that Instagram captures stay
  link-only.

The token is stored in `chrome.storage.local` on your machine and can be
revoked from **System → Ingest tokens** at any time.

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
