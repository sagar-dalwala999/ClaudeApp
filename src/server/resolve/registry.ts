/**
 * Resolver registry.
 *
 * Order is the whole strategy: platform-specific adapters first, then generic
 * discovery, then a fallback that always produces something.
 *
 *   10  x-scrape-do       blocked X pages through Scrape.do
 *   20  x-syndication     full tweet JSON incl. media (undocumented fallback)
 *   30  x-oembed          documented, no-auth text fallback
 *   40  reddit-scrape-do  blocked Reddit pages through Scrape.do
 *   50  reddit-oauth      official API fallback, 100 QPM free
 *   60  instagram-oembed  Meta oEmbed, tokenless since June 2026
 *   70  github-api        repo/issue metadata + OG social image
 *   80  youtube-oembed    title, channel, poster frame
 *   90  open-graph        any page: OG tags, JSON-LD, readable text
 *  100  url-fallback      slug-derived title so nothing is ever blank
 */
import { fallbackResolver } from "./fallback";
import { githubResolver } from "./github";
import { instagramResolver } from "./instagram";
import { openGraphResolver } from "./openGraph";
import { redditResolver, redditScrapeDoResolver } from "./reddit";
import type { Resolver } from "./types";
import { xOembedResolver, xScrapeDoResolver, xSyndicationResolver } from "./x";
import { youtubeResolver } from "./youtube";
import type { NormalizedUrl } from "../normalize/url";

export const ALL_RESOLVERS: Resolver[] = [
  xScrapeDoResolver,
  xSyndicationResolver,
  xOembedResolver,
  redditScrapeDoResolver,
  redditResolver,
  instagramResolver,
  githubResolver,
  youtubeResolver,
  openGraphResolver,
  fallbackResolver,
].sort((a, b) => a.priority - b.priority);

export function matchingResolvers(input: NormalizedUrl): Resolver[] {
  return ALL_RESOLVERS.filter((resolver) => {
    try {
      return resolver.matches(input);
    } catch {
      // A broken `matches` must never take the pipeline down.
      return false;
    }
  });
}

export function resolverById(id: string): Resolver | undefined {
  return ALL_RESOLVERS.find((r) => r.id === id);
}
