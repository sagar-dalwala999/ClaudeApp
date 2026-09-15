/**
 * Last resort.
 *
 * Always claims a hit, so an item is never left blank: a title derived from the
 * URL slug or host plus the link itself. Everything better is optional; this is
 * what makes the archive complete.
 */
import type { NormalizedUrl } from "../normalize/url";
import { titleFromSlug } from "../text/html";
import type { ResolveOutcome, Resolver } from "./types";

/** Site names we can spell properly without asking the network. */
const KNOWN_SITES: Record<string, string> = {
  "news.ycombinator.com": "Hacker News",
  "arxiv.org": "arXiv",
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
};

export function fallbackTitle(input: NormalizedUrl): string {
  const url = new URL(input.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";

  // A numeric or opaque last segment is not a title.
  if (last && !/^\d+$/.test(last) && last.length > 2) {
    const fromSlug = titleFromSlug(last);
    if (fromSlug) return fromSlug;
  }
  if (segments.length > 1) {
    const parent = titleFromSlug(segments[segments.length - 2]);
    if (parent) return parent;
  }
  return KNOWN_SITES[url.hostname] ?? url.hostname.replace(/^www\./, "");
}

export const fallbackResolver: Resolver = {
  id: "url-fallback",
  priority: 100,
  cost: "free",
  matches: () => true,

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    const url = new URL(input.url);
    return {
      status: "hit",
      content: {
        title: fallbackTitle(input),
        siteName: KNOWN_SITES[url.hostname] ?? url.hostname.replace(/^www\./, ""),
        type: input.typeHint,
        url: input.url,
        partial: true,
      },
    };
  },
};
