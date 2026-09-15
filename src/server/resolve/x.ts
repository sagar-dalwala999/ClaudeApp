/**
 * X / Twitter.
 * Scrape.do is the primary path when SCRAPE_DO_TOKENS is configured. It
 * returns the public page HTML, including text and media metadata. Requests
 * rotate through the configured token pool.
 *
 * Two free fallbacks remain:
 *
 * 1. `x-syndication` — the endpoint the official embed widget itself calls.
 *    It returns the whole tweet as JSON, media URLs included. It is
 *    undocumented and unsupported, hence the ENABLE_X_SYNDICATION flag.
 * 2. `x-oembed` — documented and tokenless, but text-only.
 *
 * Anything still missing is filled by the generic open-graph resolver.
 */
import { getEnv } from "../env";
import type { NormalizedUrl } from "../normalize/url";
import { acquire } from "../limits/rateLimit";
import { fetchJson, fetchText } from "../net/fetch";
import { scrapeDoText, scrapeDoTokens } from "../net/scrapeDo";
import { decodeEntities, htmlToText, parseHtmlMeta, titleFromText, truncateText } from "../text/html";
import type { ResolveOutcome, ResolvedMedia, Resolver } from "./types";

// The path shape is specific enough on its own: accept the short ids of the
// earliest tweets (`/status/20`) as readily as a modern 19-digit one.
const STATUS_ID = /(?:^|\/)status(?:es)?\/(\d{1,25})/;
const OEMBED_ENDPOINT = "https://publish.x.com/oembed";
const SYNDICATION_ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";

export function statusIdOf(url: URL): string | null {
  const match = `${url.pathname}${url.search}`.match(STATUS_ID);
  return match ? match[1] : null;
}

function matchesX(input: NormalizedUrl): boolean {
  return input.platform === "x" && statusIdOf(new URL(input.url)) !== null;
}

/**
 * The syndication endpoint wants a `token` parameter. Historically any value is
 * accepted; we derive a stable number from the tweet id so repeat fetches look
 * consistent rather than random.
 */
export function syndicationToken(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 1_000_003;
  return String(1_000_000 + ((hash * 7919) % 8_000_000));
}

function handleFromAuthorUrl(authorUrl: string | undefined): string | null {
  if (!authorUrl) return null;
  const match = authorUrl.match(/(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,20})/);
  return match ? `@${match[1]}` : null;
}

/** The tweet's own text, from the <p> inside the embed blockquote. */
export function textFromOembedHtml(html: string): string | null {
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlToText(m[1])).filter(Boolean);
  const joined = paragraphs.join("\n\n").trim();
  return joined ? decodeEntities(joined) : null;
}

function authorFromScrapedTitle(title: string | null): { author: string | null; handle: string | null } {
  if (!title) return { author: null, handle: null };
  const trimmed = title.trim();
  const withHandle = /^(.{1,120}?)\s+\(@([A-Za-z0-9_]{1,20})\)(?:\s+on X)?(?:\s*[:：]|$)/i.exec(trimmed);
  if (withHandle) return { author: decodeEntities(withHandle[1]).trim(), handle: `@${withHandle[2]}` };
  const loggedOut = /^(.{1,120}?)\s+on X\s*[:：]/i.exec(trimmed);
  return loggedOut ? { author: decodeEntities(loggedOut[1]).trim(), handle: null } : { author: null, handle: null };
}

function scrapedTimestamp(html: string): Date | null {
  const match = html.match(/["']timestamp["']\s*:\s*(\d{10,13})/);
  if (!match) return null;
  const raw = Number(match[1]);
  const date = new Date(raw < 10_000_000_000 ? raw * 1000 : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function scrapedLanguage(html: string, locale: string | null): string | null {
  if (locale) return locale.split(/[-_]/)[0].toLowerCase();
  return html.match(/<html\b[^>]*\blang\s*=\s*["']([A-Za-z-]{2,10})["']/i)?.[1].split("-")[0].toLowerCase() ?? null;
}

export function contentFromScrapedX(html: string, input: NormalizedUrl) {
  const page = parseHtmlMeta(html, input.url);
  const text = page.description?.trim() || null;
  const titleAuthor = authorFromScrapedTitle(page.title);
  const profileHandle = html.match(/<img\b[^>]*\balt\s*=\s*["']@([A-Za-z0-9_]{1,20})["']/i)?.[1] ?? null;
  const image = page.image
    ? [{
        kind: /<video\b[^>]*\bposter\s*=/i.test(html) ? "video" as const : "image" as const,
        remoteUrl: page.image,
        width: page.imageWidth,
        height: page.imageHeight,
        alt: text,
      }]
    : [];

  return {
    title: text ? titleFromText(text) : null,
    text: text ? truncateText(text, 20_000) : null,
    author: titleAuthor.author,
    authorHandle: titleAuthor.handle ?? (profileHandle ? `@${profileHandle}` : null),
    siteName: "X",
    language: scrapedLanguage(html, page.locale),
    publishedAt: page.publishedAt ?? scrapedTimestamp(html),
    type: "x-post" as const,
    media: image,
    url: input.url,
    canonical: page.canonical,
    meta: { scrapeDo: true },
  };
}

export const xScrapeDoResolver: Resolver = {
  id: "x-scrape-do",
  priority: 10,
  cost: "paid",
  matches: matchesX,
  unavailableReason(): string | null {
    if (!getEnv().ENABLE_LIVE_RESOLVERS) return "live resolvers disabled";
    if (!scrapeDoTokens().length) return "set SCRAPE_DO_TOKENS";
    return null;
  },
  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    await acquire("x");
    const res = await scrapeDoText(input.url);
    if (res.status === 404 || res.status === 410) return { status: "miss", reason: `post responded ${res.status}` };
    if (!res.ok) return { status: "error", reason: `Scrape.do responded ${res.status}`, httpStatus: res.status };
    const content = contentFromScrapedX(res.text, input);
    if (!content.text) return { status: "miss", reason: "scraped page contained no post body" };
    return { status: "hit", content };
  },
};

/* ------------------------------------------------------------- oEmbed */

export const xOembedResolver: Resolver = {
  id: "x-oembed",
  priority: 30,
  cost: "free",
  matches: matchesX,
  unavailableReason: () => (getEnv().ENABLE_LIVE_RESOLVERS ? null : "live resolvers disabled"),

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    await acquire("x");
    const target = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(input.url)}&omit_script=1&dnt=true&hide_thread=false`;
    const res = await fetchJson<{
      author_name?: string;
      author_url?: string;
      html?: string;
      url?: string;
      title?: string;
    }>(target, { timeoutMs: 12_000, maxBytes: 600_000, maxRedirects: 2 });

    if (!res.ok || !res.data) return { status: "miss", reason: `oEmbed responded ${res.status}` };

    const text = res.data.html ? textFromOembedHtml(res.data.html) : null;
    if (!text && !res.data.author_name) return { status: "miss", reason: "oEmbed returned no tweet body" };

    return {
      status: "hit",
      content: {
        title: text ? titleFromText(text) : null,
        text,
        author: res.data.author_name ?? null,
        authorHandle: handleFromAuthorUrl(res.data.author_url),
        siteName: "X",
        type: "x-post",
        url: res.data.url ?? input.url,
        meta: { oembed: { author_name: res.data.author_name, author_url: res.data.author_url } },
        partial: !text,
      },
    };
  },
};

/* -------------------------------------------------------- syndication */

interface SyndicationMedia {
  type?: string;
  media_url_https?: string;
  ext_alt_text?: string;
  original_info?: { width?: number; height?: number };
  video_info?: { variants?: Array<{ url?: string; content_type?: string; bitrate?: number }> };
}

export interface SyndicationTweet {
  __typename?: string;
  text?: string;
  created_at?: string;
  lang?: string;
  favorite_count?: number;
  conversation_count?: number;
  user?: { name?: string; screen_name?: string; verified?: boolean; is_blue_verified?: boolean };
  mediaDetails?: SyndicationMedia[];
  photos?: Array<{ url?: string; width?: number; height?: number }>;
  article?: { title?: string; preview_text?: string };
  entities?: { urls?: Array<{ expanded_url?: string }>; media?: Array<{ expanded_url?: string }> };
}

export function mediaFromTweet(tweet: SyndicationTweet): ResolvedMedia[] {
  const out: ResolvedMedia[] = [];
  const push = (media: ResolvedMedia) => {
    if (!media.remoteUrl || out.some((m) => m.remoteUrl === media.remoteUrl)) return;
    out.push(media);
  };

  for (const detail of tweet.mediaDetails ?? []) {
    if (!detail.media_url_https) continue;
    // Videos and gifs are represented by their poster frame; downloading the
    // mp4 is out of scope, but a still is exactly what the wall wants.
    push({
      kind: detail.type === "video" || detail.type === "animated_gif" ? "video" : "image",
      remoteUrl: detail.media_url_https,
      width: detail.original_info?.width ?? null,
      height: detail.original_info?.height ?? null,
      alt: detail.ext_alt_text ?? null,
    });
  }
  for (const photo of tweet.photos ?? []) {
    if (!photo.url) continue;
    push({ kind: "image", remoteUrl: photo.url, width: photo.width ?? null, height: photo.height ?? null, alt: null });
  }
  return out;
}

export function contentFromTweet(tweet: SyndicationTweet, input: NormalizedUrl) {
  const bodyText = (tweet.text ?? tweet.article?.preview_text ?? "").trim();
  const articleTitle = tweet.article?.title?.trim();
  const links = (tweet.entities?.urls ?? []).map((u) => u.expanded_url).filter((u): u is string => Boolean(u));
  return {
    title: articleTitle || (bodyText ? titleFromText(bodyText) : null),
    text: bodyText ? truncateText(bodyText, 20_000) : null,
    author: tweet.user?.name ?? null,
    authorHandle: tweet.user?.screen_name ? `@${tweet.user.screen_name}` : null,
    siteName: "X",
    language: tweet.lang ?? null,
    publishedAt: tweet.created_at ? new Date(tweet.created_at) : null,
    type: "x-post" as const,
    media: mediaFromTweet(tweet),
    url: input.url,
    meta: {
      favorite_count: tweet.favorite_count ?? null,
      conversation_count: tweet.conversation_count ?? null,
      outbound: links.slice(0, 5),
    },
  };
}

export const xSyndicationResolver: Resolver = {
  id: "x-syndication",
  priority: 20,
  cost: "free",
  matches: matchesX,

  unavailableReason(): string | null {
    if (!getEnv().ENABLE_LIVE_RESOLVERS) return "live resolvers disabled";
    if (!getEnv().ENABLE_X_SYNDICATION) return "disabled by ENABLE_X_SYNDICATION";
    return null;
  },

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    const id = statusIdOf(new URL(input.url));
    if (!id) return { status: "miss", reason: "no status id in URL" };

    await acquire("x");
    const target = `${SYNDICATION_ENDPOINT}?id=${id}&token=${syndicationToken(id)}&lang=en`;
    const res = await fetchText(target, {
      accept: "application/json",
      timeoutMs: 12_000,
      maxBytes: 2_000_000,
      maxRedirects: 2,
    });

    if (!res.ok) {
      return { status: "error", reason: `syndication responded ${res.status}`, httpStatus: res.status };
    }
    let tweet: SyndicationTweet | null = null;
    try {
      tweet = res.text ? (JSON.parse(res.text) as SyndicationTweet) : null;
    } catch {
      return { status: "error", reason: "syndication returned non-JSON" };
    }
    if (!tweet || typeof tweet !== "object") return { status: "miss", reason: "empty syndication payload" };
    if (!tweet.text && !tweet.article && !(tweet.mediaDetails?.length || tweet.photos?.length)) {
      return { status: "miss", reason: "tweet has no readable body (protected or deleted)" };
    }

    return { status: "hit", content: contentFromTweet(tweet, input) };
  },
};
