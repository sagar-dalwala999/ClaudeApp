/**
 * What the server does with a post the extension captured.
 *
 * The case that drove this: a launch post that is one line plus a `t.co`.
 * Resolved server-side it archives as a tagline and nothing else. Captured
 * from the page, it arrives with the card image, the text, and the link with
 * the destination the reader could see — and all three have to survive.
 */
import { describe, expect, it } from "vitest";
import {
  composeCaptureText,
  MAX_CAPTURE_ASSETS,
  normalizeCaptureAssets,
  normalizeCaptureLinks,
  upgradeAssetUrl,
} from "@/server/resolve/captureAssets";
import { captureToContent, parseCapture } from "@/server/resolve/extension";
import { normalizeUrlInput } from "@/server/normalize/url";

const X_POST = normalizeUrlInput("https://x.com/jane/status/1874");

describe("upgradeAssetUrl", () => {
  it("asks X for the full-size picture rather than the timeline crop", () => {
    expect(upgradeAssetUrl("https://pbs.twimg.com/media/A?format=jpg&name=small")).toBe(
      "https://pbs.twimg.com/media/A?format=jpg&name=large",
    );
    expect(upgradeAssetUrl("https://pbs.twimg.com/media/A.jpg:thumb")).toBe("https://pbs.twimg.com/media/A.jpg:large");
  });

  it("leaves a signed CDN URL exactly as it came", () => {
    // Editing the size out of an Instagram or Reddit URL turns a working
    // picture into a 403, because the size is part of what was signed.
    const signed = "https://scontent.cdninstagram.com/v/t51/1.jpg?stp=dst-jpg_e35_s640x640&_nc_ht=x&oh=abc";
    expect(upgradeAssetUrl(signed)).toBe(signed);
  });

  it("refuses what cannot be fetched at all", () => {
    for (const value of ["blob:https://x.com/9f2", "data:image/png;base64,AA", "", null, undefined, "not a url"]) {
      expect(upgradeAssetUrl(value)).toBeNull();
    }
  });
});

describe("normalizeCaptureAssets", () => {
  it("keeps one row per picture, at the best size", () => {
    const { assets } = normalizeCaptureAssets([
      { url: "https://pbs.twimg.com/media/A?format=jpg&name=small" },
      { url: "https://pbs.twimg.com/media/A?format=jpg&name=large" },
    ]);
    expect(assets).toHaveLength(1);
    expect(assets[0].remoteUrl).toBe("https://pbs.twimg.com/media/A?format=jpg&name=large");
  });

  it("points a video row at the video and keeps its poster separately", () => {
    const { assets } = normalizeCaptureAssets([
      { kind: "video", url: "https://video.twimg.com/a.mp4", poster: "https://pbs.twimg.com/tweet_video/p?name=small" },
    ]);
    expect(assets[0]).toMatchObject({
      kind: "video",
      remoteUrl: "https://video.twimg.com/a.mp4",
      posterUrl: "https://pbs.twimg.com/tweet_video/p?name=large",
    });
  });

  it("keeps a video that only has a poster, because the frame is still the picture", () => {
    const { assets } = normalizeCaptureAssets([{ kind: "video", poster: "https://pbs.twimg.com/tweet_video/p.jpg" }]);
    expect(assets).toHaveLength(1);
    expect(assets[0].remoteUrl).toBeNull();
    expect(assets[0].posterUrl).toBe("https://pbs.twimg.com/tweet_video/p.jpg");
  });

  it("keeps bytes the extension fetched, even with no URL to fall back on", () => {
    const base64 = "A".repeat(64);
    const { assets } = normalizeCaptureAssets([{ base64, contentType: "image/webp" }]);
    expect(assets[0].inline).toEqual({ base64, contentType: "image/webp" });
  });

  it("drops an entry with nothing to fetch and nothing to store", () => {
    const { assets } = normalizeCaptureAssets([{ alt: "described but absent" }, { base64: "tiny" }]);
    expect(assets).toHaveLength(0);
  });

  it("caps what it keeps and reports what it dropped", () => {
    const raw = Array.from({ length: MAX_CAPTURE_ASSETS + 3 }, (_, i) => ({ url: `https://example.com/${i}.jpg` }));
    const { assets, dropped } = normalizeCaptureAssets(raw);
    expect(assets).toHaveLength(MAX_CAPTURE_ASSETS);
    expect(dropped).toBe(3);
  });
});

describe("normalizeCaptureLinks", () => {
  it("keeps order, drops repeats, and refuses non-web schemes", () => {
    const links = normalizeCaptureLinks([
      { url: "https://apps.apple.com/app", display: "apps.apple.com/app" },
      { url: "https://apps.apple.com/app" },
      { url: "javascript:void(0)" },
      { url: "https://example.com/b" },
    ]);
    expect(links.map((l) => l.url)).toEqual(["https://apps.apple.com/app", "https://example.com/b"]);
    expect(links[0].display).toBe("apps.apple.com/app");
  });
});

describe("composeCaptureText", () => {
  it("writes the link destination into the body, which is the whole fix", () => {
    const text = composeCaptureText({
      text: "Launching today.",
      links: [{ url: "https://t.co/abc", display: "apps.apple.com/us/app/thing", title: "Thing for Mac" }],
    });
    expect(text).toContain("Launching today.");
    expect(text).toContain("https://t.co/abc");
    expect(text).toContain("Thing for Mac");
  });

  it("does not repeat a link the post already spelled out", () => {
    const text = composeCaptureText({
      text: "Read it at https://example.com/post",
      links: [{ url: "https://example.com/post", display: null, title: null }],
    });
    expect(text).toBe("Read it at https://example.com/post");
  });

  it("folds a quoted post in, attributed", () => {
    const text = composeCaptureText({
      text: "This.",
      links: [],
      quoted: { authorHandle: "@ada", text: "The original point." },
    });
    expect(text).toBe("This.\n\nQuoting @ada: The original point.");
  });

  it("is null when the post had no words at all", () => {
    expect(composeCaptureText({ text: null, links: [] })).toBeNull();
  });
});

describe("captureToContent, for a post", () => {
  const payload = parseCapture({
    url: "https://x.com/jane/status/1874",
    kind: "post",
    author: "Jane Doe",
    authorHandle: "jane",
    text: "Launch pointer for a new Mac app.",
    publishedAt: "2026-09-01T10:00:00.000Z",
    platform: "x",
    media: [
      { kind: "image", url: "https://pbs.twimg.com/media/CARD?format=jpg&name=small", alt: "App screenshot" },
      { kind: "video", url: "https://video.twimg.com/demo.mp4", poster: "https://pbs.twimg.com/tweet_video/p.jpg" },
    ],
    links: [{ url: "https://t.co/abc", display: "apps.apple.com/us/app/thing", title: "Thing — Mac App Store" }],
    stats: { likes: 1200, replies: 14 },
  });

  const { content, assets, links } = captureToContent(payload, X_POST, "extension");

  it("titles the item from the post's own words", () => {
    expect(content.title).toBe("Launch pointer for a new Mac app.");
  });

  it("puts the destination of the shortener into the stored text", () => {
    expect(content.text).toContain("apps.apple.com/us/app/thing");
    expect(content.text).toContain("Thing — Mac App Store");
  });

  it("carries both assets, the picture upgraded", () => {
    expect(assets).toHaveLength(2);
    expect(assets[0].remoteUrl).toBe("https://pbs.twimg.com/media/CARD?format=jpg&name=large");
    expect(assets[1].kind).toBe("video");
    expect(content.media).toHaveLength(2);
  });

  it("normalises the handle and keeps the author", () => {
    expect(content.authorHandle).toBe("@jane");
    expect(content.author).toBe("Jane Doe");
  });

  it("types the item from the URL it came from", () => {
    expect(content.type).toBe("x-post");
  });

  it("records the capture's provenance, the links and the counts", () => {
    expect(content.meta).toMatchObject({ source: "extension", kind: "post", captured: true, platform: "x" });
    expect(content.meta?.stats).toEqual({ likes: 1200, replies: 14 });
    expect(links).toHaveLength(1);
  });
});

describe("captureToContent, for a page", () => {
  it("still accepts the single-image shape a share sheet posts", () => {
    const payload = parseCapture({
      url: "https://example.com/article",
      title: "An article",
      imageUrl: "https://example.com/hero.jpg",
    });
    const { content, assets } = captureToContent(payload, normalizeUrlInput("https://example.com/article"), "share");
    expect(assets).toHaveLength(1);
    expect(assets[0].remoteUrl).toBe("https://example.com/hero.jpg");
    expect(content.meta).toMatchObject({ kind: "page", source: "share" });
  });

  it("does not store the same picture twice when both shapes carry it", () => {
    const payload = parseCapture({
      url: "https://example.com/article",
      imageUrl: "https://example.com/hero.jpg",
      media: [{ kind: "image", url: "https://example.com/hero.jpg" }],
    });
    const { assets } = captureToContent(payload, normalizeUrlInput("https://example.com/article"), "extension");
    expect(assets).toHaveLength(1);
  });
});
