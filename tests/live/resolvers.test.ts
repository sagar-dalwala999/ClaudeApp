/**
 * The resolver chain, pointed at the actual internet.
 *
 * Run with `npm run test:live`. Not part of `npm test` on purpose: these
 * depend on other people's servers, and a red run here means "a platform
 * changed something", not "the build is broken". That distinction is exactly
 * what you want when an adapter silently stops returning media.
 */
import { describe, expect, it } from "vitest";
import { normalizeUrlInput } from "@/server/normalize/url";
import { resolveItem } from "@/server/resolve";
import { ALL_RESOLVERS } from "@/server/resolve/registry";

describe("resolver registry", () => {
  it("is ordered by priority, which is what decides field conflicts", () => {
    const priorities = ALL_RESOLVERS.map((resolver) => resolver.priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  it("ends with a resolver that cannot fail, so no card is ever blank", () => {
    expect(ALL_RESOLVERS[ALL_RESOLVERS.length - 1].id).toBe("url-fallback");
  });
});

describe("a generic page", () => {
  it("comes back with a title and a source", async () => {
    const result = await resolveItem(normalizeUrlInput("https://example.com"));
    expect(result.content.title).toBeTruthy();
    expect(result.source).toBeTruthy();
    expect(result.events.some((event) => event.outcome === "hit")).toBe(true);
  });

  it("still produces a card when the page does not exist", async () => {
    // The fallback resolver derives a title from the slug: nothing is lost.
    const result = await resolveItem(normalizeUrlInput("https://example.com/there-is-no-such-page-abc123"));
    expect(result.content.title?.trim()).toBeTruthy();
  });
});

describe("platforms we can read for free", () => {
  it("reads a GitHub repository", async () => {
    const result = await resolveItem(normalizeUrlInput("https://github.com/vercel/next.js"));
    expect(result.content.title?.toLowerCase()).toContain("next.js");
  });

  it("reads a tweet without an API key", async () => {
    // The first tweet ever posted: a real id that cannot be deleted, so this
    // stays a valid probe of the X path for as long as X exists.
    const result = await resolveItem(normalizeUrlInput("https://x.com/jack/status/20"));
    expect(result.content.type).toBe("x-post");
    expect(result.content.title?.trim() || result.content.text?.trim()).toBeTruthy();
    expect(["x-scrape-do", "x-syndication", "x-oembed"]).toContain(result.source);
  });

  it("reads a YouTube video through oEmbed, with a poster frame", async () => {
    const result = await resolveItem(normalizeUrlInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    expect(result.content.title?.trim()).toBeTruthy();
    expect(result.content.media?.[0]?.remoteUrl ?? result.content.meta).toBeTruthy();
  });
});

describe("platforms that gate their content", () => {
  it("says so rather than pretending, and does not throw", async () => {
    const result = await resolveItem(normalizeUrlInput("https://www.instagram.com/p/Cxyz1234567/"));
    // Whatever Instagram returns today, the pipeline must survive it and leave
    // a truthful record of what it tried.
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => typeof event.resolver === "string")).toBe(true);
  });
});
