/**
 * The generic page resolver — the workhorse.
 *
 * For any URL: fetch the page once, read its metadata (Open Graph, Twitter
 * cards, JSON-LD), discover an oEmbed endpoint if the site publishes one, and
 * extract the readable prose. This is what makes the archive work for the long
 * tail of blogs, docs and personal sites that will never have a bespoke
 * adapter.
 *
 * robots.txt is honoured here and only here: these are ordinary web pages,
 * whereas oEmbed and API endpoints are not crawled content.
 */
import { getEnv } from "../env";
import { acquire } from "../limits/rateLimit";
import { robotsDecision } from "../limits/robots";
import { fetchJson, fetchText } from "../net/fetch";
import type { NormalizedUrl } from "../normalize/url";
import {
  extractReadableText,
  looksLikeSiteChrome,
  parseHtmlMeta,
  titleFromSlug,
  truncateText,
  type PageMeta,
} from "../text/html";
import { BODY_TEXT_LIMIT, clampText, capJsonForStorage, HTML_LIMIT } from "../text/size";
import type { ResolveOutcome, ResolvedMedia, Resolver } from "./types";

interface GenericOembed {
  title?: string;
  author_name?: string;
  provider_name?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  type?: string;
  html?: string;
}

function languageFrom(html: string, meta: PageMeta): string | null {
  if (meta.locale) {
    const short = meta.locale.split(/[-_]/)[0]?.toLowerCase();
    if (short && short.length === 2) return short;
  }
  const langMatch = html.match(/<html[^>]*\blang\s*=\s*["']([a-zA-Z-]{2,10})["']/i);
  if (langMatch) return langMatch[1].split("-")[0].toLowerCase();
  return null;
}

function isWallPage(meta: PageMeta, textLength: number): boolean {
  const haystack = `${meta.title ?? ""} ${meta.description ?? ""}`.toLowerCase();
  return (
    textLength < 400 &&
    /(log in|sign in|sign up|just a moment|enable javascript|are you a robot|access denied|verify you are human)/.test(haystack)
  );
}

export const openGraphResolver: Resolver = {
  id: "open-graph",
  priority: 90,
  cost: "free",

  matches: () => true,

  unavailableReason: () => (getEnv().ENABLE_LIVE_RESOLVERS ? null : "live resolvers disabled"),

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    const url = new URL(input.url);
    const isGenericHost = input.platform === "web";

    if (isGenericHost) {
      const decision = await robotsDecision(input.url).catch(() => null);
      if (decision && !decision.allowed) {
        return { status: "miss", reason: "disallowed by robots.txt" };
      }
    }

    await acquire(`host:${url.hostname}`);
    const res = await fetchText(input.url, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      maxBytes: getEnv().FETCH_MAX_BYTES,
      timeoutMs: getEnv().FETCH_TIMEOUT_MS,
      maxRedirects: 5,
    });

    if (res.status === 404 || res.status === 410) return { status: "miss", reason: `page gone (${res.status})` };
    if (res.status === 401 || res.status === 403) {
      return { status: "miss", reason: `page refused us (${res.status}) — likely gated content` };
    }
    if (res.status === 429) return { status: "error", reason: "rate limited (429)", httpStatus: 429 };
    if (res.status >= 500) return { status: "error", reason: `server error (${res.status})`, httpStatus: res.status };
    if (!res.ok) return { status: "miss", reason: `unexpected status ${res.status}` };

    const contentType = res.contentType.toLowerCase();
    if (!contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text/plain")) {
      // Direct link to a file: keep the URL, let the fallback name it.
      return { status: "miss", reason: `not a page (${contentType.split(";")[0] || "unknown type"})` };
    }

    const meta = parseHtmlMeta(res.text, res.url);

    // Sites that publish an oEmbed endpoint (YouTube-like CMSs, WordPress,
    // Many platforms) give cleaner title/author/thumbnail than OG tags.
    let oembed: GenericOembed | null = null;
    if (meta.oembedHref) {
      const oembedRes = await fetchJson<GenericOembed>(meta.oembedHref, {
        timeoutMs: 10_000,
        maxBytes: 300_000,
        maxRedirects: 2,
      }).catch(() => null);
      if (oembedRes?.ok && oembedRes.data) oembed = oembedRes.data;
    }

    const readable = extractReadableText(res.text, meta);
    const text = truncateText(readable.text, BODY_TEXT_LIMIT);
    if (isWallPage(meta, text.length)) {
      return { status: "miss", reason: "page is a login or challenge wall" };
    }

    const title = meta.title ?? oembed?.title ?? (url.pathname !== "/" ? titleFromSlug(url.pathname.split("/").filter(Boolean).pop() ?? "") : null);

    const media: ResolvedMedia[] = [];
    // A site logo published as `og:image` is worse than no picture: the card's
    // procedural placeholder was drawn for exactly this case.
    const image = (meta.image ?? oembed?.thumbnail_url ?? null)?.trim() ?? null;
    const usableImage = image && !looksLikeSiteChrome(image) ? image : null;
    if (usableImage) {
      media.push({
        kind: "image",
        remoteUrl: usableImage,
        width: meta.imageWidth ?? oembed?.thumbnail_width ?? null,
        height: meta.imageHeight ?? oembed?.thumbnail_height ?? null,
        alt: title,
      });
    }

    if (!title && !text && !media.length) return { status: "miss", reason: "page had no usable metadata or prose" };

    return {
      status: "hit",
      content: {
        title,
        summary: meta.description ? clampText(meta.description, 1_000) : null,
        text: text || null,
        html: readable.html ? clampText(readable.html, HTML_LIMIT) : null,
        author: meta.author ?? oembed?.author_name ?? null,
        siteName: meta.siteName ?? oembed?.provider_name ?? url.hostname.replace(/^www\./, ""),
        language: languageFrom(res.text, meta),
        publishedAt: meta.publishedAt,
        media,
        url: res.url,
        canonical: meta.canonical,
        meta: capJsonForStorage({
          openGraph: meta.openGraph,
          jsonLd: meta.jsonLd.slice(0, 2),
          strategy: readable.strategy,
          redirects: res.redirects,
          truncated: res.truncated,
        }),
      },
    };
  },
};
