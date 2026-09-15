/**
 * The button on every post.
 *
 * Feeds are virtualised: posts appear, scroll away and get recycled as you
 * read, so the button is attached by an observer rather than a single pass,
 * and each post is marked once so it never gets two.
 *
 * Clicking reads that one post — its permalink, author, text, every picture
 * and video, and the links with the destinations the page already resolved —
 * and hands it to the service worker, which fetches the bytes with your own
 * cookies and posts the lot to your archive.
 */
(function () {
  "use strict";

  if (window.__looksPostCaptureInstalled) return;
  window.__looksPostCaptureInstalled = true;

  const MARK = "data-looks-capture";
  const adapter = window.LooksPlatforms.adapterForHost(location.hostname);
  if (!adapter) return;

  let enabled = true;
  let observer = null;
  let scanQueued = false;

  /* ----------------------------------------------------------- the button */

  const SVG_NS = "http://www.w3.org/2000/svg";

  /**
   * The idle icon: a picture frame, drawn rather than typed.
   *
   * An emoji would be one character, but it renders as tofu wherever the
   * system has no emoji font, and it cannot take the button's colour. Built
   * node by node, never through innerHTML, because X enforces Trusted Types
   * and would reject the string.
   */
  function frameIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "17");
    svg.setAttribute("height", "17");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");

    const frame = document.createElementNS(SVG_NS, "rect");
    frame.setAttribute("x", "3");
    frame.setAttribute("y", "4");
    frame.setAttribute("width", "18");
    frame.setAttribute("height", "16");
    frame.setAttribute("rx", "2.5");

    const sun = document.createElementNS(SVG_NS, "circle");
    sun.setAttribute("cx", "8.6");
    sun.setAttribute("cy", "9.6");
    sun.setAttribute("r", "1.5");

    const hills = document.createElementNS(SVG_NS, "path");
    hills.setAttribute("d", "M3.5 17.5 8 13l3 3 4-4 5.5 5.5");

    svg.append(frame, sun, hills);
    return svg;
  }

  function makeButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "looks-capture-btn";
    button.title = "Save this post to Looks";
    button.setAttribute("aria-label", "Save this post to Looks");
    return button;
  }

  /** Progress as a glyph: the states use characters every font has. */
  function setState(button, state, label) {
    button.dataset.state = state;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren();
    if (state === "idle") {
      button.appendChild(frameIcon());
      return;
    }
    button.textContent = state === "saving" ? "\u00b7\u00b7\u00b7" : state === "saved" ? "\u2713" : "!";
  }

  /** A short line under the button; feeds are too noisy for anything bigger. */
  function flash(button, message, kind) {
    const existing = button.parentElement && button.parentElement.querySelector(".looks-capture-toast");
    if (existing) existing.remove();
    const toast = document.createElement("span");
    toast.className = `looks-capture-toast looks-capture-toast--${kind}`;
    toast.textContent = message;
    button.insertAdjacentElement("afterend", toast);
    setTimeout(() => toast.remove(), kind === "error" ? 7000 : 3500);
  }

  async function capture(post, button) {
    if (button.dataset.state === "saving") return;
    setState(button, "saving", "Saving…");

    let payload;
    try {
      payload = adapter.extract(post);
    } catch (err) {
      setState(button, "error", "Could not read this post");
      flash(button, `Could not read this post: ${err && err.message ? err.message : err}`, "error");
      return;
    }

    if (!payload || !payload.url) {
      // Without a permalink there is nothing stable to file the post under.
      setState(button, "error", "No link to this post");
      flash(button, "No permalink on this post — open it and use the toolbar button.", "error");
      return;
    }

    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "looks:capturePost", payload });
    } catch (err) {
      setState(button, "error", "Extension was reloaded");
      flash(button, "Reload the page — the extension restarted.", "error");
      return;
    }

    if (result && result.ok) {
      setState(button, "saved", result.created ? "Saved to Looks" : "Already in Looks, updated");
      const pictures = result.storedAssets
        ? `${result.storedAssets} ${result.storedAssets === 1 ? "picture" : "pictures"} archived`
        : "no pictures archived";
      flash(button, `${result.created ? "Saved" : "Updated"} — ${pictures}`, "ok");
      // Back to the idle icon, so the same post can be re-saved after an edit.
      setTimeout(() => {
        if (button.dataset.state === "saved") setState(button, "idle", "Save this post to Looks");
      }, 6000);
    } else {
      setState(button, "error", (result && result.error) || "Save failed");
      flash(button, (result && result.error) || "Save failed.", "error");
    }
  }

  /* ---------------------------------------------------------- attaching */

  function attach(post) {
    if (post.getAttribute(MARK) === "1") return;
    let anchor;
    try {
      anchor = adapter.anchorFor(post) || post;
    } catch {
      anchor = post;
    }
    // A post whose action row has not rendered yet gets picked up on the next
    // pass rather than a button in the wrong place.
    if (!anchor.isConnected) return;

    post.setAttribute(MARK, "1");
    const button = makeButton();
    setState(button, "idle", "Save this post to Looks");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void capture(post, button);
    });
    // Stops the platform's own click handler from opening the post.
    button.addEventListener("mousedown", (event) => event.stopPropagation());

    const host = document.createElement("div");
    host.className = "looks-capture-mount";
    host.appendChild(button);
    anchor.appendChild(host);
  }

  function scan() {
    scanQueued = false;
    if (!enabled) return;
    const posts = document.querySelectorAll(adapter.postSelector);
    for (const post of posts) attach(post);
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(queueScan);
    observer.observe(document.body, { childList: true, subtree: true });
    queueScan();
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    for (const mount of document.querySelectorAll(".looks-capture-mount")) mount.remove();
    for (const post of document.querySelectorAll(`[${MARK}]`)) post.removeAttribute(MARK);
  }

  /* -------------------------------------------------------------- wiring */

  chrome.storage.local.get(["postButtons"]).then((stored) => {
    enabled = stored.postButtons !== false;
    if (enabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.postButtons) return;
    enabled = changes.postButtons.newValue !== false;
    if (enabled) start();
    else stop();
  });

  // Single-page navigation: X swaps the whole timeline without a page load.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (enabled) queueScan();
  }, 1000);
})();
