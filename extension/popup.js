/** Popup UI: one button to save, one small form for the connection. */

const statusEl = document.getElementById("status");
const saveButton = document.getElementById("save");
const testButton = document.getElementById("test");
const serverInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const postButtonsInput = document.getElementById("postButtons");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(["serverUrl", "token", "postButtons"]);
  serverInput.value = stored.serverUrl || "";
  tokenInput.value = stored.token || "";
  // Unset means on: the buttons are the point of the extension.
  postButtonsInput.checked = stored.postButtons !== false;
  if (!stored.serverUrl || !stored.token) {
    document.getElementById("settings").open = true;
    setStatus("Set the server URL and an ingest token to start saving.", "error");
  }
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  setStatus("Reading the page…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "looks:saveFromTab" });
    if (result && result.ok) {
      setStatus(
        `${result.created ? "Saved" : "Updated"}: ${result.title || "the page"}\n${result.imageStored ? "Picture archived too." : "No picture archived — the server will try."}`,
        "ok",
      );
    } else {
      setStatus((result && result.error) || "Something went wrong.", "error");
    }
  } catch (err) {
    setStatus(String(err && err.message ? err.message : err), "error");
  } finally {
    saveButton.disabled = false;
  }
});

testButton.addEventListener("click", async () => {
  await chrome.storage.local.set({ serverUrl: serverInput.value.trim(), token: tokenInput.value.trim() });
  setStatus("Testing…");
  const result = await chrome.runtime.sendMessage({ type: "looks:testConnection" });
  if (result && result.ok) setStatus(result.message || "Connected.", "ok");
  else setStatus((result && result.error) || "Could not connect.", "error");
});

postButtonsInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ postButtons: postButtonsInput.checked });
  // The open tabs pick this up through chrome.storage.onChanged; a tab opened
  // before the extension was installed still needs one reload.
  setStatus(
    postButtonsInput.checked
      ? "Save buttons on. Reload any open X, Instagram, Reddit or Threads tab."
      : "Save buttons off.",
    "ok",
  );
});

void loadSettings();
