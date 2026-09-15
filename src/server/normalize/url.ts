/**
 * URL intake: pull a URL out of whatever the user pasted, strip the tracking
 * cruft, and derive the identity that powers dedupe.
 *
 * Pure and synchronous. Redirect resolution happens later in the resolver
 * chain, and its result is fed back through `normalizeUrlInput`.
 */
import { createHash } from "node:crypto";
import type { ItemType, Platform } from "../../lib/vocab";
import { canonicalHost, detectPlatform, platformIdentity, typeHintFor } from "./platform";

export class InvalidUrlError extends Error {
  constructor(message = "That doesn't look like a URL") {
    super(message);
    this.name = "InvalidUrlError";
  }
}

/** Query parameters that never identify content, only where you came from. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "twclid",
  "yclid",
  "ttclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "source",
  "si",
  "s",
  "sk",
  "share_id",
  "rdt",
  "trk",
  "trkcampaign",
  "feature",
  "ab_channel",
  "__twitter_impression",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
  "vero_id",
  "wickedid",
  "oly_anon_id",
  "oly_enc_id",
  "s_kwcid",
  "spm",
  "scm",
  "weibo_id",
  "hashnode",
  "wt_mc",
  "_hsenc",
  "_hsmi",
]);

const TRACKING_PREFIXES = ["utm_", "pk_", "piwik_", "matomo_", "hsa_", "vero_", "at_"];

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/i;
const BARE_PATTERN = /(?:^|[\s([<「『])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"'`)\]}]*)?)/i;

/** Trailing punctuation that belongs to the sentence, not the URL. */
function trimTrailing(value: string): string {
  return value.replace(/[.,;:!?'"”’)\]}>]+$/, "");
}

/** Finds the first URL in a string, bare domains included. */
export function extractUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const explicit = text.match(URL_PATTERN);
  if (explicit) return trimTrailing(explicit[0]);
  const bare = text.match(BARE_PATTERN);
  if (bare?.[1]) return trimTrailing(bare[1]);
  return null;
}

export function isProbablyUrl(input: string): boolean {
  return extractUrl(input) !== null;
}

function isTracking(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  return TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Lowercase host, drop `www.`/`m.` aliases and default ports. */
function normalizeHost(url: URL): string {
  const host = canonicalHost(url.hostname);
  url.hostname = host;
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  return host;
}

function normalizePath(url: URL): void {
  let path = url.pathname.replace(/\/{2,}/g, "/");
  // Keep the root slash; drop trailing slashes elsewhere so /a and /a/ are one item.
  if (path.length > 1) path = path.replace(/\/+$/, "");
  url.pathname = path || "/";
}

function normalizeQuery(url: URL): void {
  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (isTracking(key)) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
}

/** Parse and clean, without any network access. Throws InvalidUrlError. */
export function cleanUrl(raw: string): URL {
  const trimmed = trimTrailing(raw.trim());
  if (!trimmed) throw new InvalidUrlError();
  // A scheme is `foo:` where foo isn't followed by a port-like number, so
  // `mailto:x@y` is rejected while `example.com:8080/path` still parses.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    throw new InvalidUrlError(`${scheme} links are not supported`);
  }
  const withScheme = scheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidUrlError();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(`${url.protocol.replace(":", "")} links are not supported`);
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(canonicalHost(url.hostname)) && canonicalHost(url.hostname) !== "localhost") {
    throw new InvalidUrlError();
  }
  normalizeHost(url);
  normalizePath(url);
  normalizeQuery(url);
  return url;
}

/** Short stable hash used for URLs we have no structured identity for. */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export interface NormalizedUrl {
  /** Exactly what the user gave us, trimmed. */
  input: string;
  /** Cleaned absolute URL, tracking stripped, fragment kept. */
  url: string;
  /** The same URL without its fragment: what we store for comparison. */
  canonicalUrl: string;
  host: string;
  platform: Platform;
  identityKey: string;
  typeHint: ItemType;
}

export function identityForUrl(url: URL, platform: Platform = detectPlatform(url.hostname)): string {
  return platformIdentity(url, platform, (input) => {
    const withoutFragment = new URL(input.toString());
    withoutFragment.hash = "";
    return shortHash(withoutFragment.toString());
  });
}

/**
 * The entry point: anything the user pastes (a URL, a sentence containing one,
 * a bare domain) becomes a normalized record.
 */
export function normalizeUrlInput(input: string): NormalizedUrl {
  const extracted = extractUrl(input);
  if (!extracted) throw new InvalidUrlError();
  const url = cleanUrl(extracted);
  const platform = detectPlatform(url.hostname);
  const canonicalUrl = new URL(url.toString());
  canonicalUrl.hash = "";
  return {
    input: input.trim(),
    url: url.toString(),
    canonicalUrl: canonicalUrl.toString(),
    host: url.hostname,
    platform,
    identityKey: identityForUrl(url, platform),
    typeHint: typeHintFor(platform, url),
  };
}

/**
 * Re-derives identity after a resolver has followed redirects or found a
 * `<link rel="canonical">`. Prefers the platform of the *final* URL, falling
 * back to the original when the final hop is a generic shortener landing page.
 */
export function renormalizeAfterRedirect(original: NormalizedUrl, finalUrl: string, canonicalTag?: string | null): NormalizedUrl {
  try {
    const target = cleanUrl(canonicalTag || finalUrl);
    const platform = detectPlatform(target.hostname);
    const canonical = new URL(target.toString());
    canonical.hash = "";
    return {
      input: original.input,
      url: target.toString(),
      canonicalUrl: canonical.toString(),
      host: target.hostname,
      platform: platform === "web" ? original.platform : platform,
      identityKey: identityForUrl(target, platform === "web" ? original.platform : platform),
      typeHint: typeHintFor(platform === "web" ? original.platform : platform, target),
    };
  } catch {
    return original;
  }
}
