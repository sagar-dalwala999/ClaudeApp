/**
 * The extension's pure helpers, exercised as the browser loads them.
 *
 * `extension/lib.js` is a classic script for the content-script world, so it
 * is required here rather than imported — the same file the browser runs, not
 * a copy that can drift from it.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const L = require("../../extension/lib.js") as {
  absoluteUrl(href: unknown, base?: string): string | null;
  bestImageUrl(raw: unknown): string | null;
  normalizeHandle(value: unknown): string | null;
  joinText(parts: unknown[], limit?: number): string | null;
  linkRecord(href: unknown, display: unknown, base?: string): { url: string; display: string | null } | null;
  isOutboundLink(url: string, host: string): boolean;
  parseCount(value: unknown): number | null;
  dedupeAssets(assets: unknown[]): Array<Record<string, unknown>>;
};

describe("absoluteUrl", () => {
  it("resolves the relative permalink a timeline renders", () => {
    expect(L.absoluteUrl("/jane/status/1874", "https://x.com/home")).toBe("https://x.com/jane/status/1874");
  });

  it("refuses anything that is not a web link", () => {
    for (const href of ["javascript:void(0)", "#", "", null, undefined, "mailto:a@b.co"]) {
      expect(L.absoluteUrl(href, "https://x.com/home")).toBeNull();
    }
  });
});

describe("bestImageUrl", () => {
  it("asks X for the full-size variant instead of the timeline crop", () => {
    expect(L.bestImageUrl("https://pbs.twimg.com/media/ABC?format=jpg&name=small")).toBe(
      "https://pbs.twimg.com/media/ABC?format=jpg&name=large",
    );
  });

  it("leaves an original alone, because there is nothing larger", () => {
    const url = "https://pbs.twimg.com/media/ABC?format=jpg&name=orig";
    expect(L.bestImageUrl(url)).toBe(url);
  });

  it("upgrades the legacy `:small` suffix too", () => {
    expect(L.bestImageUrl("https://pbs.twimg.com/media/ABC.jpg:small")).toBe("https://pbs.twimg.com/media/ABC.jpg:large");
  });

  it("swaps a 48px avatar for the stored one", () => {
    expect(L.bestImageUrl("https://pbs.twimg.com/profile_images/1/a_normal.jpg")).toBe(
      "https://pbs.twimg.com/profile_images/1/a_400x400.jpg",
    );
  });

  it("does not touch a signed CDN URL, where the size is inside the signature", () => {
    const signed = "https://preview.redd.it/x.png?width=640&s=abc123";
    expect(L.bestImageUrl(signed)).toBe(signed);
  });

  it("drops inline and streaming sources, which cannot be fetched", () => {
    expect(L.bestImageUrl("data:image/png;base64,AAA")).toBeNull();
    expect(L.bestImageUrl("blob:https://x.com/9f2")).toBeNull();
  });
});

describe("normalizeHandle", () => {
  it("accepts a handle, a bare name and a profile path alike", () => {
    expect(L.normalizeHandle("@jane")).toBe("@jane");
    expect(L.normalizeHandle("jane")).toBe("@jane");
    expect(L.normalizeHandle("/jane/status/1")).toBe("@jane");
    expect(L.normalizeHandle("https://x.com/jane")).toBe("@jane");
  });

  it("rejects a display name, which is not a handle", () => {
    expect(L.normalizeHandle("Jane Doe")).toBeNull();
    expect(L.normalizeHandle("   ")).toBeNull();
    expect(L.normalizeHandle(null)).toBeNull();
  });
});

describe("joinText", () => {
  it("drops the separators and repeats a timeline puts between fragments", () => {
    expect(L.joinText(["Hello", "·", "Hello", "", "Show more", "World"])).toBe("Hello\n\nWorld");
  });

  it("returns null rather than an empty string when there is nothing to keep", () => {
    expect(L.joinText(["·", "", "Translate post"])).toBeNull();
    expect(L.joinText([])).toBeNull();
  });

  it("honours the ceiling", () => {
    expect(L.joinText(["x".repeat(50)], 10)).toHaveLength(10);
  });
});

describe("linkRecord", () => {
  it("keeps the destination the post displays next to a shortener", () => {
    // This is the whole point: t.co says nothing, the displayed text says where it goes.
    const record = L.linkRecord("https://t.co/abc123", "apps.apple.com/us/app/thing…", "https://x.com/home");
    expect(record).toEqual({ url: "https://t.co/abc123", display: "apps.apple.com/us/app/thing" });
  });

  it("stores no display when it would just repeat the URL", () => {
    const record = L.linkRecord("https://example.com/a", "https://example.com/a", "https://x.com/home");
    expect(record?.display).toBeNull();
  });
});

describe("isOutboundLink", () => {
  it("keeps links that leave the platform, shorteners included", () => {
    expect(L.isOutboundLink("https://t.co/abc", "x.com")).toBe(true);
    expect(L.isOutboundLink("https://apps.apple.com/app", "x.com")).toBe(true);
  });

  it("drops navigation back into the platform itself", () => {
    expect(L.isOutboundLink("https://x.com/jane", "x.com")).toBe(false);
    expect(L.isOutboundLink("https://www.instagram.com/p/1", "instagram.com")).toBe(false);
    expect(L.isOutboundLink("https://reddit.com/r/design", "x.com")).toBe(false);
  });
});

describe("parseCount", () => {
  it("reads the abbreviations a feed shows", () => {
    expect(L.parseCount("1.2K")).toBe(1200);
    expect(L.parseCount("3.4M")).toBe(3_400_000);
    expect(L.parseCount("847")).toBe(847);
    expect(L.parseCount("1,204")).toBe(1204);
  });

  it("is null for a label that is not a count", () => {
    expect(L.parseCount("Reply")).toBeNull();
    expect(L.parseCount("")).toBeNull();
    expect(L.parseCount(null)).toBeNull();
  });
});

describe("dedupeAssets", () => {
  it("treats two sizes of one picture as one asset", () => {
    const assets = L.dedupeAssets([
      { url: "https://pbs.twimg.com/media/A?format=jpg&name=small" },
      { url: "https://pbs.twimg.com/media/A?format=jpg&name=large" },
      { url: "https://pbs.twimg.com/media/B?format=jpg&name=large" },
    ]);
    expect(assets).toHaveLength(2);
  });

  it("drops entries with nothing to fetch", () => {
    expect(L.dedupeAssets([{ alt: "no source" }, null, { url: "https://example.com/a.jpg" }])).toHaveLength(1);
  });
});
