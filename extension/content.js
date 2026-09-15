/**
 * Reads the page you are looking at.
 *
 * Runs in the tab, so it sees exactly what you see — the logged-in Instagram
 * post, the X thread, the paywalled article you are subscribed to. It sends
 * metadata plus the URL of the best picture; the service worker fetches the
 * bytes, because a content script cannot read a cross-origin image.
 */
(function () {
  if (window.__looksCollectorInstalled) return;
  window.__looksCollectorInstalled = true;

  const MAX_TEXT = 20000;

  function meta(...names) {
    for (const name of names) {
      const el =
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[name="${name}"]`) ||
        document.querySelector(`meta[itemprop="${name}"]`);
      const content = el && el.getAttribute("content");
      if (content && content.trim()) return content.trim();
    }
    return null;
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el && el.innerText ? el.innerText.trim() : "";
      if (text && text.length > 1) return text;
    }
    return null;
  }

  function host() {
    return location.hostname.replace(/^www\./, "");
  }

  /** The largest image that is actually rendered, ignoring avatars and icons. */
  function bestImageUrl() {
    const candidates = Array.from(document.images)
      .filter((img) => img.naturalWidth >= 320 && img.naturalHeight >= 200 && img.currentSrc)
      .map((img) => ({
        url: img.currentSrc,
        area: img.naturalWidth * img.naturalHeight,
        visible: Boolean(img.offsetParent),
      }))
      .filter((candidate) => candidate.visible)
      .sort((a, b) => b.area - a.area);
    return candidates.length ? candidates[0].url : null;
  }

  function readBodyText() {
    const container = document.querySelector("article") || document.querySelector("main") || document.body;
    if (!container) return null;
    const blocks = Array.from(container.querySelectorAll("p, h2, h3, blockquote, li"))
      .map((el) => (el.innerText || "").trim())
      .filter((text) => text.length > 1);
    const joined = blocks.join("\n\n").trim();
    return joined ? joined.slice(0, MAX_TEXT) : null;
  }

  /** Platform-specific extras, which generic meta tags miss. */
  function platformExtras() {
    const extras = {};

    if (host().includes("instagram.com") || host().includes("threads.")) {
      extras.authorHandle = firstText(["header a[href^='/']", "a[href^='/'] span"]) || null;
      extras.text =
        firstText(["h1", "div[role='button'] span", "article div span"]) || readBodyText();
    }

    if (host() === "x.com" || host() === "twitter.com") {
      const tweet = document.querySelector("article[data-testid='tweet']") || document.querySelector("article");
      if (tweet) {
        extras.text = Array.from(tweet.querySelectorAll("[data-testid='tweetText'], div[lang]"))
          .map((el) => (el.innerText || "").trim())
          .filter(Boolean)
          .join("\n\n")
          .slice(0, MAX_TEXT);
        const handleEl = tweet.querySelector("a[href^='/'][role='link'] span");
        extras.authorHandle = handleEl ? handleEl.innerText.trim() : null;
      }
    }

    if (host().includes("reddit.com")) {
      extras.text = firstText(["[data-test-id='post-content']", "div[slot='text-body']"]) || readBodyText();
    }

    if (host().includes("youtube.com")) {
      extras.text = firstText(["#description-inline-expander", "#description"]) || null;
    }

    return extras;
  }

  function collect() {
    const extras = platformExtras();
    const title = meta("og:title", "twitter:title") || document.title || null;
    const description = meta("og:description", "twitter:description", "description");
    const imageUrl = meta("og:image", "og:image:url", "twitter:image") || bestImageUrl();
    const text = extras.text || readBodyText() || description || null;

    return {
      url: location.href,
      title,
      description,
      text,
      author: meta("author", "article:author", "og:article:author"),
      authorHandle: extras.authorHandle || meta("twitter:creator"),
      siteName: meta("og:site_name") || host(),
      language: document.documentElement.lang || null,
      publishedAt: meta("article:published_time", "og:article:published_time", "datePublished"),
      imageUrl: imageUrl || null,
      platform: host(),
      pageTitle: document.title,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "looks:collect") {
      try {
        sendResponse({ ok: true, payload: collect() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    }
    return true;
  });
})();
