import { describe, expect, it } from "vitest";
import {
  bareHandle,
  displayAuthor,
  hashSeed,
  hostOf,
  kindFor,
  mediaUrl,
  relativeDay,
  styleFor,
  toClientItem,
  type ClientMedia,
  type ItemLike,
} from "@/lib/item";

function row(overrides: Partial<ItemLike> = {}): ItemLike {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    url: "https://www.example.com/posts/thing",
    canonicalUrl: "https://example.com/posts/thing",
    platform: "web",
    type: "article",
    title: "A thing",
    summary: "It is a thing.",
    note: null,
    author: "Ada Lovelace",
    authorHandle: "@ada",
    siteName: "Example",
    language: "en",
    publishedAt: "2026-03-01T00:00:00.000Z",
    addedAt: "2026-03-04T12:00:00.000Z",
    updatedAt: "2026-03-04T12:00:00.000Z",
    status: "ready",
    source: "paste",
    lastError: null,
    favorite: false,
    ai: true,
    hasEmbedding: true,
    needsCapture: false,
    tags: ["design"],
    collections: [{ id: "c1", name: "Interfaces" }],
    media: [],
    ...overrides,
  };
}

describe("toClientItem", () => {
  it("fills the derived fields the canvas renderers read", () => {
    const item = toClientItem(row());
    expect(item.caption).toBe(item.title);
    expect(item.host).toBe("example.com");
    expect(item.author).toBe("ada");
    expect(item.style).toBe("type");
    expect(item.kind).toBe("text");
  });

  it("never leaves a card without a label", () => {
    expect(toClientItem(row({ title: "  " })).title).toBe("example.com");
    expect(toClientItem(row({ title: null, url: "https://example.com" })).title).toBe("example.com");
  });

  it("falls back to a neutral aspect until the picture is known", () => {
    expect(toClientItem(row()).aspect).toBe(0.68);
  });

  it("reads the aspect from the first media row and clamps the extremes", () => {
    const media: ClientMedia[] = [
      { id: "m1", kind: "image", storageKey: "k", remoteUrl: null, width: 1000, height: 600, placeholder: null, alt: null },
    ];
    expect(toClientItem(row({ media })).aspect).toBe(0.6);

    const panorama = [{ ...media[0], width: 4000, height: 500 }];
    expect(toClientItem(row({ media: panorama })).aspect).toBe(0.5);

    const skyscraper = [{ ...media[0], width: 500, height: 4000 }];
    expect(toClientItem(row({ media: skyscraper })).aspect).toBe(1.8);
  });

  it("seeds the procedural placeholder deterministically", () => {
    const a = toClientItem(row());
    const b = toClientItem(row());
    expect(a.seed).toBe(b.seed);
    expect(toClientItem(row({ type: "paper" })).seed).not.toBe(a.seed);
  });

  it("passes the note and tags straight through", () => {
    const item = toClientItem(row({ note: "read this weekend", tags: ["a", "b"] }));
    expect(item.note).toBe("read this weekend");
    expect(item.tags).toEqual(["a", "b"]);
    expect(item.collections).toEqual([{ id: "c1", name: "Interfaces" }]);
  });
});

describe("display fields", () => {
  it("prefers the handle, then the name, then the site", () => {
    expect(displayAuthor({ author: "Ada", authorHandle: "@ada", siteName: "S", url: "https://x.com" })).toBe("ada");
    expect(displayAuthor({ author: "Ada", authorHandle: null, siteName: "S", url: "https://x.com" })).toBe("Ada");
    expect(displayAuthor({ author: null, authorHandle: null, siteName: "S", url: "https://x.com" })).toBe("S");
    expect(displayAuthor({ author: null, authorHandle: null, siteName: null, url: "https://example.com/a" })).toBe("example.com");
  });

  it("strips handle decoration", () => {
    expect(bareHandle("@ada")).toBe("ada");
    expect(bareHandle("u/spez")).toBe("spez");
    expect(bareHandle("  ")).toBeNull();
    expect(bareHandle(null)).toBeNull();
  });

  it("derives the host without the www", () => {
    expect(hostOf("https://www.example.com/a")).toBe("example.com");
    expect(hostOf("not a url")).toBe("");
  });

  it("classifies what the card should show", () => {
    expect(kindFor({ type: "article", media: [] })).toBe("text");
    expect(kindFor({ type: "article", media: [{ kind: "image" }] })).toBe("image");
    expect(kindFor({ type: "article", media: [{ kind: "video" }] })).toBe("video");
    expect(kindFor({ type: "video", media: [] })).toBe("video");
  });

  it("maps a type onto a procedural family", () => {
    expect(styleFor({ type: "github", platform: "github" })).toBe("grid");
    expect(styleFor({ type: "paper", platform: "arxiv" })).toBe("document");
    expect(styleFor({ type: "x-post", platform: "x" })).toBe("halftone");
    expect(styleFor({ type: "tool", platform: "web" })).toBe("ui");
    expect(styleFor({ type: "other", platform: "instagram" })).toBe("photo");
  });

  it("only builds an image URL for media we actually store", () => {
    const base: ClientMedia = {
      id: "m1",
      kind: "image",
      storageKey: "user/ab/cd",
      remoteUrl: null,
      width: null,
      height: null,
      placeholder: null,
      alt: null,
    };
    expect(mediaUrl(base)).toBe("/api/img?key=user%2Fab%2Fcd&v=card");
    expect(mediaUrl(base, "full")).toBe("/api/img?key=user%2Fab%2Fcd&v=full");
    expect(mediaUrl({ ...base, storageKey: null })).toBeNull();
  });

  it("hashes to a stable unsigned 32-bit seed", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
    expect(hashSeed("abc")).toBeGreaterThanOrEqual(0);
  });
});

describe("relativeDay", () => {
  const now = new Date("2026-03-10T12:00:00.000Z");

  it("names the recent past in the units a person would use", () => {
    expect(relativeDay("2026-03-10T09:00:00.000Z", now)).toBe("today");
    expect(relativeDay("2026-03-09T09:00:00.000Z", now)).toBe("yesterday");
    expect(relativeDay("2026-03-06T12:00:00.000Z", now)).toBe("4 days ago");
    expect(relativeDay("2026-03-01T12:00:00.000Z", now)).toBe("1w ago");
    expect(relativeDay("2026-01-10T12:00:00.000Z", now)).toBe("1mo ago");
    expect(relativeDay("2024-03-10T12:00:00.000Z", now)).toBe("2y ago");
  });

  it("returns an empty string for a date it cannot read", () => {
    expect(relativeDay("yesterday", now)).toBe("");
  });
});
