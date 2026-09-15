import { describe, expect, it } from "vitest";
import { cleanUrl, extractUrl, identityForUrl, isProbablyUrl, normalizeUrlInput, renormalizeAfterRedirect, InvalidUrlError } from "@/server/normalize/url";
import { canonicalHost, detectPlatform, typeHintFor } from "@/server/normalize/platform";

describe("extractUrl", () => {
  it("finds a URL inside pasted prose", () => {
    expect(extractUrl("this is great https://example.com/a?b=1, read it")).toBe("https://example.com/a?b=1");
  });

  it("accepts a bare domain", () => {
    expect(extractUrl("example.com/post")).toBe("example.com/post");
  });

  it("strips trailing sentence punctuation", () => {
    expect(extractUrl("see https://example.com/thing.")).toBe("https://example.com/thing");
  });

  it("returns null when there is no URL", () => {
    expect(extractUrl("no links here")).toBeNull();
    expect(isProbablyUrl("no links here")).toBe(false);
  });
});

describe("cleanUrl", () => {
  it("adds a scheme and normalises the host", () => {
    expect(cleanUrl("example.com/a").toString()).toBe("https://example.com/a");
    expect(cleanUrl("https://www.example.com/a").toString()).toBe("https://example.com/a");
  });

  it("aliases platform hosts", () => {
    expect(canonicalHost("www.twitter.com")).toBe("x.com");
    expect(canonicalHost("old.reddit.com")).toBe("reddit.com");
    expect(canonicalHost("threads.com")).toBe("threads.net");
  });

  it("drops tracking parameters and sorts the rest", () => {
    const url = cleanUrl("https://example.com/a?utm_source=x&b=2&a=1&fbclid=abc");
    expect(url.search).toBe("?a=1&b=2");
  });

  it("keeps meaningful query parameters", () => {
    expect(cleanUrl("https://youtube.com/watch?v=abc123&t=90").searchParams.get("v")).toBe("abc123");
  });

  it("collapses trailing slashes but keeps the root", () => {
    expect(cleanUrl("https://example.com/a/b/").pathname).toBe("/a/b");
    expect(cleanUrl("https://example.com/").pathname).toBe("/");
  });

  it("refuses non-web schemes", () => {
    expect(() => cleanUrl("mailto:someone@example.com")).toThrow(InvalidUrlError);
    expect(() => cleanUrl("file:///etc/passwd")).toThrow(InvalidUrlError);
    expect(() => cleanUrl("not a url")).toThrow(InvalidUrlError);
  });
});

describe("platform detection", () => {
  const cases: Array<[string, string]> = [
    ["https://x.com/a/status/1", "x"],
    ["https://twitter.com/a/status/1", "x"],
    ["https://www.reddit.com/r/x/comments/abc123/title/", "reddit"],
    ["https://www.instagram.com/p/Cxyz123/", "instagram"],
    ["https://github.com/vercel/next.js", "github"],
    ["https://gist.github.com/user/abc", "github"],
    ["https://youtu.be/abc123", "youtube"],
    ["https://arxiv.org/abs/2101.00001", "arxiv"],
    ["https://news.ycombinator.com/item?id=1", "hackernews"],
    ["https://example.com/blog/post", "web"],
  ];

  it.each(cases)("%s → %s", (input, platform) => {
    expect(detectPlatform(new URL(input).hostname)).toBe(platform);
  });

  it("hints a type from the platform", () => {
    expect(typeHintFor("github", new URL("https://github.com/a/b"))).toBe("github");
    expect(typeHintFor("youtube", new URL("https://youtu.be/x"))).toBe("video");
    expect(typeHintFor("arxiv", new URL("https://arxiv.org/abs/1"))).toBe("paper");
    expect(typeHintFor("x", new URL("https://x.com/a/status/1"))).toBe("x-post");
  });
});

describe("identity keys (the dedupe guarantee)", () => {
  const identities: Array<[string, string]> = [
    ["https://x.com/alice/status/1234567890", "x:1234567890"],
    ["https://twitter.com/alice/status/1234567890?s=20", "x:1234567890"],
    ["https://x.com/i/web/status/1234567890", "x:1234567890"],
    ["https://mobile.twitter.com/alice/statuses/1234567890", "x:1234567890"],
    ["https://www.reddit.com/r/programming/comments/abc123/a_title/", "reddit:abc123"],
    ["https://redd.it/abc123", "reddit:abc123"],
    ["https://www.instagram.com/p/Cxyz123/", "instagram:Cxyz123"],
    ["https://www.instagram.com/reel/Cxyz123/", "instagram:Cxyz123"],
    ["https://github.com/vercel/next.js", "gh:vercel/next.js"],
    ["https://github.com/vercel/next.js/issues/42", "gh:vercel/next.js#issues/42"],
    ["https://github.com/vercel/next.js/pull/43", "gh:vercel/next.js#pr/43"],
    ["https://youtu.be/abc123", "youtube:abc123"],
    ["https://www.youtube.com/watch?v=abc123&t=30", "youtube:abc123"],
    ["https://arxiv.org/abs/2101.00001", "arxiv:2101.00001"],
    ["https://news.ycombinator.com/item?id=42", "hn:42"],
  ];

  it.each(identities)("%s → %s", (input, expected) => {
    expect(normalizeUrlInput(input).identityKey).toBe(expected);
  });

  it("treats the same tweet pasted in different shapes as one item", () => {
    const shapes = [
      "https://x.com/alice/status/1234567890",
      "https://twitter.com/alice/status/1234567890?s=20",
      "https://x.com/i/web/status/1234567890",
    ].map((input) => normalizeUrlInput(input).identityKey);
    expect(new Set(shapes).size).toBe(1);
  });

  it("does not collapse different items on the same repo", () => {
    const repo = normalizeUrlInput("https://github.com/a/b").identityKey;
    const issue = normalizeUrlInput("https://github.com/a/b/issues/1").identityKey;
    expect(repo).not.toBe(issue);
  });

  it("strips the fragment from the identity but keeps it in the URL", () => {
    const normalized = normalizeUrlInput("https://example.com/docs#install");
    expect(normalized.url).toBe("https://example.com/docs#install");
    expect(normalized.canonicalUrl).toBe("https://example.com/docs");
  });

  it("falls back to a stable hash for unknown sites", () => {
    const a = normalizeUrlInput("https://example.com/a?b=1&utm_source=x");
    const b = normalizeUrlInput("https://example.com/a?b=1");
    expect(a.identityKey).toBe(b.identityKey);
    expect(a.identityKey.startsWith("url:")).toBe(true);
  });
});

describe("redirects and canonical tags", () => {
  it("re-derives identity from the destination", () => {
    const initial = normalizeUrlInput("https://bit.ly/abc");
    const resolved = renormalizeAfterRedirect(initial, "https://github.com/a/b");
    expect(resolved.identityKey).toBe("gh:a/b");
    expect(resolved.platform).toBe("github");
  });

  it("prefers a canonical tag when one is present", () => {
    const initial = normalizeUrlInput("https://example.com/blog/post?ref=share");
    const resolved = renormalizeAfterRedirect(initial, "https://example.com/blog/post", "https://example.com/canonical-post");
    expect(resolved.canonicalUrl).toContain("canonical-post");
  });

  it("keeps the original when the destination is unusable", () => {
    const initial = normalizeUrlInput("https://example.com/a");
    expect(renormalizeAfterRedirect(initial, "not a url").identityKey).toBe(initial.identityKey);
  });
});

describe("identityForUrl", () => {
  it("hashes only the canonical form", () => {
    const a = identityForUrl(new URL("https://example.com/x?a=1#frag"));
    const b = identityForUrl(new URL("https://example.com/x?a=1"));
    expect(a).toBe(b);
  });
});
