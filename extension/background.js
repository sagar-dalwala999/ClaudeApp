/**
 * Service worker.
 *
 * The only place with the privileges this needs: with host permissions the
 * extension can fetch an image from a platform CDN *using your cookies*, which
 * is exactly what a server-side fetch cannot do for Instagram or X. Then it
 * posts everything to your archive.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    if (blob.size > MAX_IMAGE_BYTES) return null;
    return { base64: await blobToBase64(blob), contentType: blob.type };
  } catch {
    // Cross-origin without permission, or the CDN refused: the server will try
    // to fetch it itself instead.
    return null;
  }
}

async function save(payload) {
  const { serverUrl, token } = await settings();
  if (!serverUrl || !token) {
    return { ok: false, error: "Open the extension options and set your server URL and an ingest token." };
  }

  const body = { ...payload };
  if (payload.imageUrl) {
    const bytes = await fetchImageBytes(payload.imageUrl);
    if (bytes) {
      body.imageBase64 = bytes.base64;
      body.imageContentType = bytes.contentType;
    }
  }
  delete body.pageTitle;

  let res;
  try {
    res = await fetch(`${serverUrl}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach ${serverUrl} — is serverUrl right, and is the app running?` };
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
    title: parsed && parsed.item ? parsed.item.title : body.title,
    imageStored: Boolean(body.imageBase64),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

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
      return save(collected.payload);
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
