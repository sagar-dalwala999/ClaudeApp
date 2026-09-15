/**
 * Reading one post out of a feed.
 *
 * Each adapter answers three questions for its platform: what counts as a
 * post, where the button goes, and what that post is made of. Everything a
 * server-side fetch cannot see — the text as rendered, every picture at the
 * size the page loaded, the video source, the shortener with its destination
 * already resolved on screen — comes from here.
 *
 * Selectors are the fragile part by design: they are all in this file, one
 * adapter each, so a platform reshuffling its markup is a small, obvious fix.
 */
(function (root) {
  "use strict";

  const L = root.LooksCapture;
  const MAX_TEXT = 20000;

  /** Avatars, emoji and spacer gifs are not the post's pictures. */
  function isContentImage(img) {
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    if (width && width < 140) return false;
    if (height && height < 140) return false;
    const src = img.currentSrc || img.src || "";
    if (!src || src.startsWith("data:")) return false;
    if (/\/emoji\/|\/profile_images\/|\/spacer|_normal\.(jpg|png|webp)/i.test(src)) return false;
    return true;
  }

  function imageAsset(img, alt) {
    const url = L.bestImageUrl(img.currentSrc || img.src);
    if (!url) return null;
    return {
      kind: "image",
      url,
      width: img.naturalWidth || null,
      height: img.naturalHeight || null,
      alt: (alt || img.alt || "").trim() || null,
    };
  }

  /**
   * A `<video>` as an asset.
   *
   * Timelines play from a blob: URL fed by MSE, which is not fetchable, so the
   * poster frame is what actually gets archived; the source URL is kept when
   * the player exposes a real one.
   */
  function videoAsset(video) {
    const direct = video.currentSrc || video.src || "";
    const source = video.querySelector("source");
    const candidate = direct && !direct.startsWith("blob:") ? direct : source ? source.src : "";
    const url = L.absoluteUrl(candidate);
    const poster = L.bestImageUrl(video.poster);
    if (!url && !poster) return null;
    return {
      kind: "video",
      url: url || null,
      poster: poster || null,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      durationMs: Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : null,
    };
  }

  /** Every picture and video inside an element, in the order they are shown. */
  function collectAssets(scope, alt) {
    const assets = [];
    const nodes = scope.querySelectorAll("img, video");
    for (const node of nodes) {
      const asset = node.tagName === "VIDEO" ? videoAsset(node) : isContentImage(node) ? imageAsset(node, alt) : null;
      if (asset) assets.push(asset);
    }
    return L.dedupeAssets(assets);
  }

  /** Outbound links with the destination the page displays for them. */
  function collectLinks(scope, host) {
    const links = [];
    for (const anchor of scope.querySelectorAll("a[href]")) {
      const record = L.linkRecord(anchor.getAttribute("href"), anchor.textContent, location.href);
      if (!record || !L.isOutboundLink(record.url, host)) continue;
      // X puts the real destination in the anchor's title when it truncates it.
      const title = (anchor.getAttribute("title") || "").trim();
      if (title && title !== record.url) record.title = title;
      links.push(record);
    }
    return links;
  }

  /**
   * The text as read, not as marked up.
   *
   * `innerText` is what is actually on screen — hidden spans excluded, block
   * breaks included — which is what an archive of a post should hold. It is
   * absent in non-rendering contexts, so `textContent` stands in.
   */
  function textOf(el) {
    if (!el) return "";
    const rendered = el.innerText;
    return typeof rendered === "string" ? rendered : el.textContent || "";
  }

  /* ------------------------------------------------------------------- X */

  const x = {
    id: "x",
    platform: "x",
    hosts: ["x.com", "twitter.com"],
    postSelector: "article[data-testid='tweet']",
    /** The action row, so the button sits with reply/repost/like. */
    anchorFor(post) {
      return post.querySelector("[role='group']") || post;
    },
    extract(post) {
      // The permalink is the only link wrapping the timestamp.
      const timeEl = post.querySelector("time");
      const permalink = timeEl && timeEl.closest("a[href*='/status/']");
      const url = L.absoluteUrl(permalink && permalink.getAttribute("href"), location.href);

      const nameBlock = post.querySelector("[data-testid='User-Name']");
      const nameParts = nameBlock ? Array.from(nameBlock.querySelectorAll("span")).map((s) => s.textContent.trim()) : [];
      const author = nameParts.find((part) => part && !part.startsWith("@") && part !== "·") || null;
      const handleText = nameParts.find((part) => part && part.startsWith("@"));
      const handle =
        L.normalizeHandle(handleText) ||
        L.normalizeHandle(url && new URL(url).pathname.split("/").filter(Boolean)[0]);

      const textEl = post.querySelector("[data-testid='tweetText']");
      const text = L.joinText([textOf(textEl)], MAX_TEXT);

      // A quoted post is a nested article-like block with its own text.
      const quotedRoot = post.querySelector("div[role='link'][tabindex]");
      let quoted = null;
      if (quotedRoot && quotedRoot.querySelector("[data-testid='tweetText']")) {
        const quotedNames = Array.from(quotedRoot.querySelectorAll("[data-testid='User-Name'] span")).map((s) =>
          s.textContent.trim(),
        );
        quoted = {
          author: quotedNames.find((part) => part && !part.startsWith("@") && part !== "·") || null,
          authorHandle: L.normalizeHandle(quotedNames.find((part) => part && part.startsWith("@"))),
          text: L.joinText([textOf(quotedRoot.querySelector("[data-testid='tweetText']"))], 4000),
        };
      }

      // The card is the link preview: for a post that is a tagline plus a
      // shortener, this picture and its domain are the entire substance.
      const card = post.querySelector("[data-testid='card.wrapper']");
      const cardLink = card && card.querySelector("a[href]");
      const links = collectLinks(post.querySelector("[data-testid='tweetText']") || post, "x.com");
      if (cardLink) {
        const record = L.linkRecord(cardLink.getAttribute("href"), textOf(card).split("\n")[0], location.href);
        if (record && L.isOutboundLink(record.url, "x.com")) {
          const cardText = L.joinText([textOf(card)], 300);
          if (cardText) record.title = cardText;
          links.unshift(record);
        }
      }

      const group = post.querySelector("[role='group']");
      const stats = {};
      if (group) {
        for (const [key, testid] of [
          ["replies", "reply"],
          ["reposts", "retweet"],
          ["likes", "like"],
        ]) {
          const button = group.querySelector(`[data-testid='${testid}']`);
          const count = button && L.parseCount(textOf(button));
          if (count != null) stats[key] = count;
        }
      }

      const avatar = post.querySelector("[data-testid='Tweet-User-Avatar'] img, img[src*='/profile_images/']");

      return {
        url,
        kind: "post",
        platform: "x",
        siteName: "X",
        author,
        authorHandle: handle,
        avatarUrl: avatar ? L.bestImageUrl(avatar.currentSrc || avatar.src) : null,
        text,
        publishedAt: timeEl ? timeEl.getAttribute("datetime") : null,
        media: collectAssets(post, text),
        links,
        quoted: quoted && (quoted.text || quoted.authorHandle) ? quoted : null,
        stats: Object.keys(stats).length ? stats : null,
      };
    },
  };

  /* ----------------------------------------------------------- Instagram */

  const instagram = {
    id: "instagram",
    platform: "instagram",
    hosts: ["instagram.com"],
    postSelector: "article",
    anchorFor(post) {
      return post.querySelector("section") || post;
    },
    extract(post) {
      const permalink = post.querySelector("a[href*='/p/'], a[href*='/reel/']");
      const url = L.absoluteUrl(permalink && permalink.getAttribute("href"), location.href);

      const header = post.querySelector("header");
      const profileLink = header && header.querySelector("a[href^='/']");
      const handle = L.normalizeHandle(profileLink && profileLink.getAttribute("href"));

      // The caption is the first long run of text under the media.
      const candidates = Array.from(post.querySelectorAll("h1, li span[dir='auto'], span[dir='auto']"))
        .map((el) => textOf(el).trim())
        .filter((value) => value.length > 20);
      const text = L.joinText(candidates.slice(0, 2), MAX_TEXT);

      const timeEl = post.querySelector("time");

      return {
        url,
        kind: "post",
        platform: "instagram",
        siteName: "Instagram",
        author: profileLink ? textOf(profileLink).trim() || null : null,
        authorHandle: handle,
        avatarUrl: header ? (() => {
          const img = header.querySelector("img");
          return img ? L.bestImageUrl(img.currentSrc || img.src) : null;
        })() : null,
        text,
        publishedAt: timeEl ? timeEl.getAttribute("datetime") : null,
        media: collectAssets(post, text),
        links: collectLinks(post, "instagram.com"),
        quoted: null,
        stats: null,
      };
    },
  };

  /* -------------------------------------------------------------- Reddit */

  const reddit = {
    id: "reddit",
    platform: "reddit",
    hosts: ["reddit.com"],
    postSelector: "shreddit-post",
    anchorFor(post) {
      return post.querySelector("[slot='credit-bar']") || post;
    },
    extract(post) {
      const permalink = post.getAttribute("permalink") || post.getAttribute("content-href");
      const url = L.absoluteUrl(permalink, location.href);
      const author = post.getAttribute("author");
      const body = post.querySelector("[slot='text-body']");
      const title = post.getAttribute("post-title") || textOf(post.querySelector("[slot='title']")).trim() || null;
      const text = L.joinText([title, textOf(body)], MAX_TEXT);

      const thumbnail = post.getAttribute("content-href");
      const assets = collectAssets(post, title);
      // A link post's target is the substance, not the (empty) body.
      const links = collectLinks(post, "reddit.com");
      if (thumbnail && /^https?:/i.test(thumbnail) && L.isOutboundLink(thumbnail, "reddit.com")) {
        const record = L.linkRecord(thumbnail, null, location.href);
        if (record) links.unshift(record);
      }

      return {
        url,
        title,
        kind: "post",
        platform: "reddit",
        siteName: "Reddit",
        author: author || null,
        authorHandle: author ? `u/${String(author).replace(/^u\//, "")}` : null,
        avatarUrl: null,
        text,
        publishedAt: post.getAttribute("created-timestamp"),
        media: assets,
        links,
        quoted: null,
        stats: {
          likes: L.parseCount(post.getAttribute("score")),
          replies: L.parseCount(post.getAttribute("comment-count")),
        },
      };
    },
  };

  /* ------------------------------------------------------------- Threads */

  const threads = {
    id: "threads",
    platform: "threads",
    hosts: ["threads.com", "threads.net"],
    postSelector: "[data-pressable-container='true']",
    anchorFor(post) {
      return post;
    },
    extract(post) {
      const permalink = post.querySelector("a[href*='/post/']");
      const url = L.absoluteUrl(permalink && permalink.getAttribute("href"), location.href);
      const profileLink = post.querySelector("a[href^='/@']");
      const handle = L.normalizeHandle(profileLink && profileLink.getAttribute("href").replace(/^\/@?/, ""));
      const text = L.joinText(
        Array.from(post.querySelectorAll("span[dir='auto']")).map((el) => textOf(el)),
        MAX_TEXT,
      );
      const timeEl = post.querySelector("time");

      return {
        url,
        kind: "post",
        platform: "threads",
        siteName: "Threads",
        author: null,
        authorHandle: handle,
        avatarUrl: null,
        text,
        publishedAt: timeEl ? timeEl.getAttribute("datetime") : null,
        media: collectAssets(post, text),
        links: collectLinks(post, location.hostname),
        quoted: null,
        stats: null,
      };
    },
  };

  const ADAPTERS = [x, instagram, reddit, threads];

  /** The adapter for a hostname, or null when this page has no posts. */
  function adapterForHost(hostname) {
    const host = String(hostname || "").replace(/^www\./, "").toLowerCase();
    return (
      ADAPTERS.find((adapter) => adapter.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null
    );
  }

  root.LooksPlatforms = { ADAPTERS, adapterForHost, collectAssets, collectLinks };
  if (typeof module !== "undefined" && module.exports) module.exports = root.LooksPlatforms;
})(typeof globalThis !== "undefined" ? globalThis : this);
