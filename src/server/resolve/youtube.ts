/**
 * YouTube and Vimeo.
 *
 * Their oEmbed endpoints are documented, need no key, and return the title,
 * channel and poster frame. They do not return the description, so this
 * resolver deliberately leaves `text` empty: it is not "complete", which lets
 * the generic open-graph resolver run afterwards and fill in the description
 * and published date from the watch page.
 */
import { getEnv } from "../env";
import { acquire } from "../limits/rateLimit";
import { fetchJson } from "../net/fetch";
import type { NormalizedUrl } from "../normalize/url";
import type { ResolveOutcome, ResolvedMedia, Resolver } from "./types";

function endpointFor(platform: string, url: string): string | null {
  if (platform === "youtube") return `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  if (platform === "vimeo") return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
  return null;
}

interface OembedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  provider_name?: string;
  duration?: number;
  video_id?: number;
  error?: string;
}

/** Vimeo's oEmbed gives no hashtag, but the author_url carries the handle. */
export function handleFromAuthorUrl(authorUrl: string | undefined, platform: string): string | null {
  if (!authorUrl) return null;
  if (platform === "youtube") {
    const match = authorUrl.match(/youtube\.com\/@?([A-Za-z0-9._-]{2,40})/);
    return match ? `@${match[1]}` : null;
  }
  const match = authorUrl.match(/vimeo\.com\/([A-Za-z0-9._-]{2,40})/);
  return match ? `@${match[1]}` : null;
}

export const youtubeResolver: Resolver = {
  id: "youtube-oembed",
  priority: 80,
  cost: "free",
  matches: (input) => input.platform === "youtube" || input.platform === "vimeo",

  unavailableReason: () => (getEnv().ENABLE_LIVE_RESOLVERS ? null : "live resolvers disabled"),

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    const endpoint = endpointFor(input.platform, input.url);
    if (!endpoint) return { status: "miss", reason: "unsupported video host" };

    await acquire("youtube");
    const res = await fetchJson<OembedResponse>(endpoint, { timeoutMs: 12_000, maxBytes: 400_000, maxRedirects: 2 });

    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return { status: "miss", reason: `video unavailable (${res.status})` };
    }
    if (!res.ok || !res.data || res.data.error) {
      return { status: "miss", reason: `oEmbed responded ${res.status}` };
    }

    const media: ResolvedMedia[] = res.data.thumbnail_url
      ? [
          {
            kind: "video",
            remoteUrl: res.data.thumbnail_url,
            width: res.data.thumbnail_width ?? null,
            height: res.data.thumbnail_height ?? null,
            alt: res.data.title ?? null,
          },
        ]
      : [];

    return {
      status: "hit",
      content: {
        title: res.data.title ?? null,
        // Left empty on purpose: the open-graph pass fills in the description.
        author: res.data.author_name ?? null,
        authorHandle: handleFromAuthorUrl(res.data.author_url, input.platform),
        siteName: res.data.provider_name ?? (input.platform === "youtube" ? "YouTube" : "Vimeo"),
        type: "video",
        media,
        meta: { duration: res.data.duration ?? null },
      },
    };
  },
};
