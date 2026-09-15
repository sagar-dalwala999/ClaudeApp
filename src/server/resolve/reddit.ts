/**
 * Reddit.
 * Scrape.do is the primary path when SCRAPE_DO_TOKENS is configured. Reddit
 * needs its residential `super=true` mode to avoid soft-blocked 200 responses.
 *
 * The official Data API remains a fallback. A "script" app gives 100 queries
 * per minute on the free tier (non-commercial use only). With
 * REDDIT_USERNAME/PASSWORD set we use the password grant; otherwise
 * client_credentials, which is enough for public posts.
 */
import { getEnv } from "../env";
import { acquire } from "../limits/rateLimit";
import { fetchJson, fetchText } from "../net/fetch";
import { scrapeDoText, scrapeDoTokens } from "../net/scrapeDo";
import type { NormalizedUrl } from "../normalize/url";
import { decodeEntities, htmlToText, titleFromText, truncateText } from "../text/html";
import type { ResolveOutcome, ResolvedMedia, Resolver } from "./types";

const TOKEN_ENDPOINT = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";

export interface RedditPostData {
  title?: string;
  selftext?: string;
  author?: string;
  subreddit_name_prefixed?: string;
  created_utc?: number;
  permalink?: string;
  url?: string;
  url_overridden_by_dest?: string;
  domain?: string;
  thumbnail?: string;
  is_self?: boolean;
  is_video?: boolean;
  over_18?: boolean;
  score?: number;
  num_comments?: number;
  link_flair_text?: string;
  post_hint?: string;
  preview?: {
    images?: Array<{
      source?: { url?: string; width?: number; height?: number };
      variants?: Record<string, { source?: { url?: string } }>;
    }>;
  };
}

interface RedditListing {
  data?: { children?: Array<{ kind?: string; data?: RedditPostData }> };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

export function postIdOf(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.indexOf("comments");
  const id = index !== -1 ? parts[index + 1] : undefined;
  return id && /^[a-z0-9]{4,12}$/i.test(id) ? id : null;
}

function configured(): boolean {
  const env = getEnv();
  return Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const env = getEnv();
  const form = new URLSearchParams();
  if (env.REDDIT_USERNAME && env.REDDIT_PASSWORD) {
    form.set("grant_type", "password");
    form.set("username", env.REDDIT_USERNAME);
    form.set("password", env.REDDIT_PASSWORD);
  } else {
    form.set("grant_type", "client_credentials");
  }

  const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetchText(TOKEN_ENDPOINT, {
    method: "POST",
    body: form.toString(),
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    accept: "application/json",
    timeoutMs: 12_000,
    maxBytes: 200_000,
  });
  if (!res.ok) throw new Error(`Reddit token request failed (${res.status})`);

  let parsed: { access_token?: string; expires_in?: number; error?: string };
  try {
    parsed = JSON.parse(res.text) as typeof parsed;
  } catch {
    throw new Error("Reddit token response was not JSON");
  }
  if (!parsed.access_token) throw new Error(`Reddit refused the token: ${parsed.error ?? "unknown error"}`);

  cachedToken = { token: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

/** Reddit's preview URLs arrive HTML-escaped. */
export function unescapeRedditUrl(value: string): string {
  return decodeEntities(value.replace(/&amp;/g, "&"));
}

export function mediaFromPost(post: RedditPostData): ResolvedMedia[] {
  const out: ResolvedMedia[] = [];
  const image = post.preview?.images?.[0];
  const source = image?.source?.url;
  if (source) {
    const url = unescapeRedditUrl(source);
    out.push({
      kind: post.is_video ? "video" : "image",
      remoteUrl: url,
      width: image?.source?.width ?? null,
      height: image?.source?.height ?? null,
      alt: post.title ?? null,
    });
  }
  return out;
}

function typeFromUrl(target: string | undefined): "video" | "github" | "article" {
  if (!target) return "article";
  if (/youtube\.com|youtu\.be|vimeo\.com/.test(target)) return "video";
  if (/github\.com|gitlab\.com/.test(target)) return "github";
  return "article";
}

export function contentFromPost(post: RedditPostData, input: NormalizedUrl) {
  const selftext = (post.selftext ?? "").trim();
  const external = post.url_overridden_by_dest ?? post.url ?? "";
  const descriptor = post.is_self
    ? selftext
    : [post.title, external ? `Link post → ${external}` : "", post.domain ? `(${post.domain})` : ""]
        .filter(Boolean)
        .join("\n");

  const flairTags = (post.link_flair_text ?? "")
    .split(/[,/|]/)
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);

  return {
    title: post.title?.trim() || (selftext ? titleFromText(selftext) : null),
    text: descriptor ? truncateText(descriptor, 20_000) : null,
    author: post.author ?? null,
    authorHandle: post.author ? `u/${post.author}` : null,
    siteName: post.subreddit_name_prefixed ?? "Reddit",
    publishedAt: post.created_utc ? new Date(post.created_utc * 1000) : null,
    type: typeFromUrl(external),
    tags: flairTags.slice(0, 4),
    media: mediaFromPost(post),
    url: input.url,
    canonical: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
    meta: {
      score: post.score ?? null,
      comments: post.num_comments ?? null,
      over_18: post.over_18 ?? null,
      external: external || null,
    },
  };
}

function tagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag))) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function rootPost(html: string, id: string): { attributes: Record<string, string>; html: string } | null {
  const open = new RegExp(`<shreddit-post\\b(?=[^>]*\\bid=[\"']t3_${id}[\"'])[^>]*>`, "i").exec(html);
  if (!open || open.index === undefined) return null;
  const end = html.indexOf("</shreddit-post>", open.index + open[0].length);
  if (end === -1) return null;
  return {
    attributes: tagAttributes(open[0]),
    html: html.slice(open.index, end + "</shreddit-post>".length),
  };
}

function redditBody(postHtml: string): string | null {
  const body = /<([a-z][a-z0-9-]*)\b[^>]*\bproperty\s*=\s*["']schema:articleBody["'][^>]*>([\s\S]*?)<\/\1>/i.exec(postHtml);
  const text = body ? htmlToText(body[2]).trim() : "";
  return text || null;
}

function scrapedRedditMedia(postHtml: string, title: string | null): ResolvedMedia[] {
  const media: ResolvedMedia[] = [];
  const seen = new Set<string>();
  const push = (entry: ResolvedMedia) => {
    if (seen.has(entry.remoteUrl)) return;
    seen.add(entry.remoteUrl);
    media.push(entry);
  };

  for (const match of postHtml.matchAll(/<img\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    if (!(attributes.class ?? "").split(/\s+/).includes("media-lightbox-img")) continue;
    const remoteUrl = attributes.src ?? attributes["data-lazy-src"];
    if (!remoteUrl) continue;
    push({
      kind: "image",
      remoteUrl,
      width: Number(attributes.width) || null,
      height: Number(attributes.height) || null,
      alt: attributes.alt?.trim() || title,
    });
  }
  for (const match of postHtml.matchAll(/<video\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    if (!attributes.poster) continue;
    push({
      kind: "video",
      remoteUrl: attributes.poster,
      width: Number(attributes.width) || null,
      height: Number(attributes.height) || null,
      alt: title,
    });
  }
  return media;
}

export function contentFromScrapedReddit(html: string, input: NormalizedUrl) {
  const id = postIdOf(new URL(input.url));
  if (!id) return null;
  const post = rootPost(html, id);
  if (!post) return null;

  const attributes = post.attributes;
  const heading = new RegExp(`<h1\\b[^>]*\\bid=[\"']post-title-t3_${id}[\"'][^>]*>([\\s\\S]*?)<\\/h1>`, "i").exec(post.html);
  const title = attributes["post-title"]?.trim() || (heading ? htmlToText(heading[1]).trim() : "") || null;
  const body = redditBody(post.html);
  const external = attributes["content-href"]?.trim() || "";
  const isNativePost = external.includes(`/gallery/${id}`) || external.includes(`/comments/${id}`);
  const text = body || (!isNativePost && external ? [title, `Link post → ${external}`].filter(Boolean).join("\n") : null);
  const author =
    attributes.author?.trim() ||
    post.html.match(/\baria-label\s*=\s*["']Author:\s*([^"']+)["']/i)?.[1]?.trim() ||
    null;
  const publishedAt = attributes["created-timestamp"] ? new Date(attributes["created-timestamp"]) : null;
  const permalink = attributes.permalink?.trim() || null;
  const postType = attributes["post-type"] ?? "";

  return {
    title: title || (text ? titleFromText(text) : null),
    text: text ? truncateText(text, 20_000) : null,
    author,
    authorHandle: author ? `u/${author}` : null,
    siteName: attributes["subreddit-prefixed-name"]?.trim() || "Reddit",
    language: attributes["post-language"]?.trim() || null,
    publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    type: postType === "video" ? "video" as const : typeFromUrl(!isNativePost ? external : undefined),
    media: scrapedRedditMedia(post.html, title),
    url: input.url,
    canonical: permalink ? new URL(permalink, "https://www.reddit.com").toString() : null,
    meta: {
      scrapeDo: true,
      score: Number(attributes.score) || null,
      comments: Number(attributes["comment-count"]) || null,
      external: !isNativePost && external ? external : null,
    },
  };
}

export const redditScrapeDoResolver: Resolver = {
  id: "reddit-scrape-do",
  priority: 40,
  cost: "paid",
  matches: (input) => input.platform === "reddit" && postIdOf(new URL(input.url)) !== null,
  unavailableReason(): string | null {
    if (!getEnv().ENABLE_LIVE_RESOLVERS) return "live resolvers disabled";
    if (!scrapeDoTokens().length) return "set SCRAPE_DO_TOKENS";
    return null;
  },
  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    await acquire("reddit");
    const res = await scrapeDoText(input.url, { super: true });
    if (res.status === 404 || res.status === 410) return { status: "miss", reason: `post responded ${res.status}` };
    if (!res.ok) return { status: "error", reason: `Scrape.do responded ${res.status}`, httpStatus: res.status };
    const content = contentFromScrapedReddit(res.text, input);
    if (!content?.title) return { status: "miss", reason: "scraped page contained no matching post" };
    return { status: "hit", content };
  },
};

export const redditResolver: Resolver = {
  id: "reddit-oauth",
  priority: 50,
  cost: "free",
  matches: (input) => input.platform === "reddit" && postIdOf(new URL(input.url)) !== null,

  unavailableReason(): string | null {
    if (!getEnv().ENABLE_LIVE_RESOLVERS) return "live resolvers disabled";
    if (!configured()) return "set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET";
    return null;
  },

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    const id = postIdOf(new URL(input.url));
    if (!id) return { status: "miss", reason: "no post id in URL" };

    let token: string;
    try {
      token = await accessToken();
    } catch (err) {
      return { status: "error", reason: err instanceof Error ? err.message : String(err) };
    }

    await acquire("reddit");
    const res = await fetchJson<RedditListing>(`${API_BASE}/api/info?id=t3_${id}&raw_json=1`, {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 12_000,
      maxBytes: 1_000_000,
    });

    if (res.status === 401) {
      cachedToken = null;
      return { status: "error", reason: "Reddit rejected the token (401)", httpStatus: 401 };
    }
    if (res.status === 403) {
      return { status: "error", reason: "Reddit refused access (403) — check app type and credentials", httpStatus: 403 };
    }
    if (res.status === 429) {
      return { status: "error", reason: "Reddit rate limit hit (429)", httpStatus: 429 };
    }
    if (!res.ok) return { status: "miss", reason: `Reddit responded ${res.status}` };

    const post = res.data?.data?.children?.[0]?.data;
    if (!post) return { status: "miss", reason: "post not found (deleted or private)" };

    return { status: "hit", content: contentFromPost(post, input) };
  },
};
