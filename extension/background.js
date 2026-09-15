/**
 * Service worker.
 *
 * The only place with the privileges this needs: with host permissions the
 * extension can fetch an image from a platform CDN *using your cookies*, which
 * is exactly what a server-side fetch cannot do for Instagram or X. Then it
 * posts everything to your archive.
 *
 * It also outlives the thing that asked: a post capture started from a
 * timeline keeps running after you scroll the post out of view, and a page
 * capture finishes after the popup closes.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Pictures fetched per post. The server keeps four; over-fetching wastes bandwidth. */
const MAX_ASSETS_PER_POST = 4;
/** One slow CDN should not hold a capture open forever. */
const ASSET_TIMEOUT_MS = 15000;

async function settings() {
  const stored = await chrome.storage.local.get(["serverUrl", "token"]);
  return {
    serverUrl: (stored.serverUrl || "").trim().replace(/\/+$/, ""),
    token: (stored.token || "").trim(),
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

async function fetchImageBytes(url) {
  if (!url) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ASSET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: "include", signal: abort.signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    if (blob.size > MAX_IMAGE_BYTES) return null;
    return { base64: await blobToBase64(blob), contentType: blob.type };
  } catch {
    // Cross-origin without permission, aborted, or the CDN refused: the server
    // will try to fetch it itself instead.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns the assets a post listed into assets with bytes.
 *
 * A picture behind a login is only ours if we fetch it here, in a context that
 * has your cookies; a video's bytes are never ours, so its poster frame is
 * what gets archived and the source URL rides along.
 */
async function withBytes(assets) {
  const wanted = (assets || []).slice(0, MAX_ASSETS_PER_POST);
  return Promise.all(
    wanted.map(async (asset) => {
      const out = { ...asset };
      const target = asset.kind === "video" ? asset.poster : asset.url;
      const bytes = await fetchImageBytes(target);
      if (bytes) {
        out.base64 = bytes.base64;
        out.contentType = bytes.contentType;
      }
      return out;
    }),
  );
}

async function postToArchive(body) {
  const { serverUrl, token } = await settings();
  if (!serverUrl || !token) {
    return { ok: false, error: "Open the extension and set your server URL and an ingest token." };
  }

  let res;
  try {
    res = await fetch(`${serverUrl}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: `Could not reach ${serverUrl} — is the URL right, and is the app running?` };
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    return { ok: false, error: (parsed && parsed.error) || `Server responded ${res.status}` };
  }
  return {
    ok: true,
    created: Boolean(parsed && parsed.created),
    storedAssets: (parsed && parsed.storedAssets) || 0,
    title: parsed && parsed.item ? parsed.item.title : body.title,
  };
}

/** The toolbar button: one page, one picture. */
async function savePage(payload) {
  const body = { ...payload, kind: "page" };
  if (payload.imageUrl) {
    const bytes = await fetchImageBytes(payload.imageUrl);
    if (bytes) {
      body.imageBase64 = bytes.base64;
      body.imageContentType = bytes.contentType;
    }
  }
  delete body.pageTitle;

  const result = await postToArchive(body);
  return result.ok ? { ...result, imageStored: result.storedAssets > 0 } : result;
}

/** The per-post button: one post, everything in it. */
async function savePost(payload) {
  const media = await withBytes(payload.media);
  return postToArchive({
    ...payload,
    kind: "post",
    media,
    capturedAt: new Date().toISOString(),
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "looks:capturePost") {
    // Deliberately not awaited by the sender's tab: the reply comes back
    // whenever the CDN and the server are done, even if the post has scrolled
    // away by then.
    savePost(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === "looks:saveFromTab") {
    // Collect from the active tab, then save. All in the worker so the popup
    // can close without cancelling the request.
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return { ok: false, error: "No active tab" };
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      } catch {
        /* already injected */
      }
      const collected = await chrome.tabs.sendMessage(tab.id, { type: "looks:collect" }).catch(() => null);
      if (!collected || !collected.ok) {
        return { ok: false, error: (collected && collected.error) || "Could not read the page" };
      }
      return savePage(collected.payload);
    })().then(sendResponse);
    return true;
  }

  if (message.type === "looks:testConnection") {
    (async () => {
      const { serverUrl, token } = await settings();
      if (!serverUrl || !token) return { ok: false, error: "Set the server URL and token first." };
      try {
        const res = await fetch(`${serverUrl}/api/health`);
        if (!res.ok) return { ok: false, error: `Health check returned ${res.status}` };
        const health = await res.json();
        return { ok: true, message: `Reached Looks (database ${health.database}, ai ${health.ai})` };
      } catch {
        return { ok: false, error: "Could not reach that server URL." };
      }
    })().then(sendResponse);
    return true;
  }

  return false;
});
