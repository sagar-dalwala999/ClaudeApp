/**
 * Instagram, Facebook and Threads, through Meta's oEmbed APIs.
 *
 * Since 15 June 2026 these endpoints are callable without an access token and
 * without App Review, at 1,000 requests per endpoint per hour.
 *
 * The catch, and the reason this resolver cannot stand alone: since the
 * November 2025 "Meta oEmbed Read" migration the responses no longer include
 * `thumbnail_url`, `author_name` or `author_url`. We get the official embed
 * HTML and nothing visual. The caption is often recoverable from that HTML,
 * but the picture is not — for that the archive needs the browser extension
 * (see needsCapture in ./index.ts) or a paid provider behind this same
 * interface.
 *
 * Threads is included optimistically: it shares Meta's oEmbed family, and if
 * the endpoint path ever differs the resolver simply misses and the generic
 * open-graph resolver takes over.
 */
import { getEnv } from "../env";
import { acquire } from "../limits/rateLimit";
import { fetchJson } from "../net/fetch";
import type { NormalizedUrl } from "../normalize/url";
import { htmlToText, titleFromText, truncateText } from "../text/html";
import type { ResolveOutcome, ResolvedMedia, Resolver } from "./types";

const API_VERSION = "v25.0";

export function oembedEndpointFor(platform: string): string | null {
  switch (platform) {
    case "instagram":
      return `https://graph.facebook.com/${API_VERSION}/instagram_oembed`;
    case "facebook":
      return `https://graph.facebook.com/${API_VERSION}/oembed_post`;
    case "threads":
      return `https://graph.threads.net/v1.0/oembed`;
    default:
      return null;
  }
}

interface MetaOembedResponse {
  version?: string;
  provider_name?: string;
  provider_url?: string;
  html?: string;
  width?: number;
  height?: number;
  type?: string;
  title?: string;
  /** Deprecated by Meta, but tolerated in case it comes back. */
  author_name?: string;
  thumbnail_url?: string;
  error?: { message?: string; type?: string; code?: number };
}

/** Lines the embed markup adds that are never the caption. */
const BOILERPLATE = [
  /^view this post on instagram/i,
  /^a post shared by/i,
  /^a photo posted by/i,
  /^see photos and videos/i,
  /^see instagram photos and videos/i,
  /^instagram$/i,
  /^facebook$/i,
  /^threads$/i,
  /^log ?in/i,
  /^sign ?up/i,
  /^create an account/i,
  /^embed$/i,
  /^copy link$/i,
  /^\d[\d,.]*\s+(likes?|comments?|views?)/i,
  /^@?[a-z0-9._]{1,30}$/i,
];

export interface EmbedExtract {
  caption: string | null;
  permalink: string | null;
  imageUrl: string | null;
}

/**
 * Pulls what we can out of the embed HTML: the canonical permalink, the
 * caption text, and opportunistically an image if the markup happens to carry
 * one (older Instagram payloads did).
 */
export function extractFromEmbedHtml(html: string): EmbedExtract {
  const permalinkMatch =
    html.match(/data-instgrm-permalink="([^"]+)"/i) ??
    html.match(/href="(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[^"]+)"/i) ??
    html.match(/href="(https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[^"]+)"/i);
  const permalink = permalinkMatch ? permalinkMatch[1].replace(/&amp;/g, "&") : null;

  const imageMatch = html.match(/https:\/\/[^"'\s]+\.(?:jpe?g|png|webp)(?:\?[^"'\s]*)?/i);

  const text = htmlToText(html);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !BOILERPLATE.some((pattern) => pattern.test(line)));
  const caption = lines.join(" ").replace(/\s+/g, " ").trim();

  return {
    caption: caption.length >= 8 ? caption : null,
    permalink,
    imageUrl: imageMatch ? imageMatch[0] : null,
  };
}

export const instagramResolver: Resolver = {
  id: "instagram-oembed",
  priority: 60,
  cost: "free",

  matches(input) {
    if (input.platform === "threads") return /\/post\//.test(input.url);
    return input.platform === "instagram" || input.platform === "facebook";
  },

  unavailableReason: () => (getEnv().ENABLE_LIVE_RESOLVERS ? null : "live resolvers disabled"),

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    const endpoint = oembedEndpointFor(input.platform);
    if (!endpoint) return { status: "miss", reason: `no Meta oEmbed endpoint for ${input.platform}` };

    await acquire(input.platform);
    const target = `${endpoint}?url=${encodeURIComponent(input.url)}&maxwidth=540`;
    const res = await fetchJson<MetaOembedResponse>(target, {
      timeoutMs: 12_000,
      maxBytes: 800_000,
      maxRedirects: 2,
    });

    if (res.data?.error) {
      return { status: "miss", reason: `Meta oEmbed error: ${res.data.error.message ?? "unknown"}` };
    }
    if (!res.ok || !res.data) {
      const retryable = res.status === 429 || res.status >= 500;
      return retryable
        ? { status: "error", reason: `Meta oEmbed responded ${res.status}`, httpStatus: res.status }
        : { status: "miss", reason: `Meta oEmbed responded ${res.status}` };
    }

    const extract = res.data.html ? extractFromEmbedHtml(res.data.html) : { caption: null, permalink: null, imageUrl: null };
    const media: ResolvedMedia[] = [];
    if (res.data.thumbnail_url) {
      media.push({ kind: "image", remoteUrl: res.data.thumbnail_url, width: null, height: null, alt: null });
    } else if (extract.imageUrl) {
      media.push({ kind: "image", remoteUrl: extract.imageUrl, width: null, height: null, alt: null });
    }

    const caption = extract.caption;
    if (!caption && !media.length && !extract.permalink) {
      return { status: "miss", reason: "Meta oEmbed returned no readable content" };
    }

    return {
      status: "hit",
      content: {
        title: caption ? titleFromText(caption) : null,
        text: caption ? truncateText(caption, 8_000) : null,
        author: res.data.author_name ?? null,
        siteName: res.data.provider_name ?? (input.platform === "instagram" ? "Instagram" : "Meta"),
        type: input.platform === "instagram" ? "other" : "x-post",
        media,
        url: extract.permalink ?? input.url,
        canonical: extract.permalink,
        // No caption and no image means we only have the embed: worth showing,
        // not worth treating as a complete record.
        partial: !caption || media.length === 0,
        meta: {
          provider: res.data.provider_name ?? null,
          embed_type: res.data.type ?? null,
          note: caption ? (media.length ? null : "caption without media — capture with the extension for the image") : "no caption in embed",
        },
      },
    };
  },
};
