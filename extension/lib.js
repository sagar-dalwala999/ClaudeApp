/**
 * Pure helpers shared by the content scripts.
 *
 * No DOM, no chrome APIs, no state — just the string and array rules that
 * decide what a captured post is made of. Kept separate because this is the
 * part worth testing (tests/unit/extensionLib.test.ts runs this exact file),
 * and because a content script is a classic script, so sharing code means
 * sharing a global.
 */
(function (root) {
  "use strict";

  /** Text nodes a timeline renders that carry no meaning in an archive. */
  const NOISE = new Set(["·", "—", "-", "|", "", "…", "Show more", "Translate post", "Read more"]);

  /** Absolute URL for a href that may be relative, or null if it is unusable. */
  function absoluteUrl(href, base) {
    if (!href) return null;
    const trimmed = String(href).trim();
    if (!trimmed || trimmed.startsWith("javascript:") || trimmed === "#") return null;
    try {
      const url = new URL(trimmed, base || undefined);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  /**
   * The picture at full size.
   *
   * A timeline renders `name=small`; the archive should keep the real thing.
   * Mirrors upgradeAssetUrl in src/server/resolve/captureAssets.ts, which
   * applies the same rule to whatever reaches the server by another route.
   */
  function bestImageUrl(raw) {
    const url = absoluteUrl(raw);
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "pbs.twimg.com" && host !== "abs.twimg.com") return url;

    if (parsed.searchParams.has("name")) {
      if (parsed.searchParams.get("name") !== "orig") parsed.searchParams.set("name", "large");
      return parsed.toString();
    }
    const legacy = parsed.pathname.match(/^(.*)(:(?:thumb|small|medium|large|orig))$/);
    if (legacy) {
      parsed.pathname = `${legacy[1]}:large`;
      return parsed.toString();
    }
    if (/_(normal|bigger|mini)\.(jpg|jpeg|png|webp)$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/_(normal|bigger|mini)\./i, "_400x400.");
      return parsed.toString();
    }
    return parsed.toString();
  }

  /** `@name`, from a handle, a profile path, or a display string. */
  function normalizeHandle(value) {
    if (!value) return null;
    let text = String(value).trim();
    if (!text) return null;
    // A profile URL or path: take the first segment.
    if (text.includes("/")) {
      const parts = text.replace(/^https?:\/\/[^/]+/i, "").split("/").filter(Boolean);
      if (!parts.length) return null;
      text = parts[0];
    }
    text = text.replace(/^@+/, "").trim();
    if (!text || !/^[A-Za-z0-9._-]{1,60}$/.test(text)) return null;
    return `@${text}`;
  }

  /** Joins visible fragments into prose, dropping the timeline's furniture. */
  function joinText(parts, limit) {
    const max = limit || 20000;
    const seen = new Set();
    const kept = [];
    for (const part of parts || []) {
      const text = String(part == null ? "" : part).replace(/ /g, " ").trim();
      if (!text || NOISE.has(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      kept.push(text);
    }
    const joined = kept.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    return joined ? joined.slice(0, max) : null;
  }

  /**
   * A shortened link is worth keeping only with its destination attached.
   *
   * X renders `t.co/abc` but shows `apps.apple.com/us/app/…` to the reader and
   * puts it in the anchor's title. That displayed text is the substance the
   * archive was missing, so it travels with the link.
   */
  function linkRecord(href, displayText, base) {
    const url = absoluteUrl(href, base);
    if (!url) return null;
    const display = String(displayText == null ? "" : displayText)
      .replace(/…/g, "")
      .replace(/\s+/g, "")
      .trim();
    return { url, display: display && display !== url ? display : null };
  }

  /** Drops links that only point back into the post's own platform. */
  function isOutboundLink(url, host) {
    try {
      const parsed = new URL(url);
      const linkHost = parsed.hostname.replace(/^www\./, "").toLowerCase();
      const pageHost = String(host || "").replace(/^www\./, "").toLowerCase();
      if (linkHost === pageHost) return false;
      // x.com renders its own links through t.co; keep those, they leave.
      return !/^(?:[a-z0-9-]+\.)*(?:x\.com|twitter\.com|instagram\.com|reddit\.com|redd\.it)$/.test(linkHost) || linkHost === "t.co";
    } catch {
      return false;
    }
  }

  /** Counts as X renders them: "1.2K" → 1200, "3.4M" → 3400000. */
  function parseCount(value) {
    if (value == null) return null;
    const text = String(value).trim().replace(/,/g, "");
    const match = text.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    const scale = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || "").toLowerCase()] || 1;
    return Math.round(amount * scale);
  }

  /** Removes duplicate assets and anything with nothing to fetch. */
  function dedupeAssets(assets) {
    const out = [];
    const seen = new Set();
    for (const asset of assets || []) {
      if (!asset || (!asset.url && !asset.poster)) continue;
      const identity = String(asset.url || asset.poster).replace(/([?&])name=[a-z0-9]+/i, "$1name=*");
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push(asset);
    }
    return out;
  }

  const api = {
    absoluteUrl,
    bestImageUrl,
    normalizeHandle,
    joinText,
    linkRecord,
    isOutboundLink,
    parseCount,
    dedupeAssets,
  };

  root.LooksCapture = api;
  // Node, for the unit tests. Browsers never take this branch.
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
