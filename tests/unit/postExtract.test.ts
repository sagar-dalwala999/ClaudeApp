/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://x.com/home" }
 *
 * Reading a post out of a rendered timeline.
 *
 * The adapters in `extension/platforms.js` are the fragile part of the whole
 * feature — they depend on someone else's markup — so they are exercised here
 * against the shape a timeline actually renders, in a real DOM, running the
 * same file the browser loads. The fixture below is trimmed X markup: the
 * attributes the adapter keys off are exactly the ones X uses.
 */
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface ExtractedPost {
  url: string | null;
  author: string | null;
  authorHandle: string | null;
  text: string | null;
  publishedAt: string | null;
  media: Array<{ kind: string; url?: string | null; poster?: string | null; alt?: string | null }>;
  links: Array<{ url: string; display: string | null; title?: string }>;
  quoted: { authorHandle: string | null; text: string | null } | null;
  stats: Record<string, number> | null;
}

interface Adapter {
  id: string;
  postSelector: string;
  anchorFor(post: Element): Element | null;
  extract(post: Element): ExtractedPost;
}

function loadAdapters(): { adapterForHost(host: string): Adapter | null } {
  // Content scripts are classic scripts sharing a global; `require` gives the
  // same effect here, and keeps the test pointed at the shipped files.
  require("../../extension/lib.js");
  return require("../../extension/platforms.js");
}

/** One post, the way X renders a launch announcement with a link card. */
const X_POST = `
<article data-testid="tweet">
  <div data-testid="Tweet-User-Avatar">
    <img src="https://pbs.twimg.com/profile_images/1/jane_normal.jpg" alt="" />
  </div>
  <div data-testid="User-Name">
    <span>Jane Doe</span><span>@jane</span><span>·</span><span>2h</span>
  </div>
  <a href="/jane/status/1874" role="link"><time datetime="2026-09-01T10:00:00.000Z">2h</time></a>
  <div data-testid="tweetText">
    <span>Launch pointer for a new Mac app.</span>
    <a href="https://t.co/abc123" title="https://apps.apple.com/us/app/thing/id1">apps.apple.com/us/app/thing…</a>
  </div>
  <div data-testid="card.wrapper">
    <a href="https://t.co/abc123">
      <img src="https://pbs.twimg.com/card_img/999?format=jpg&amp;name=small" alt="Thing screenshot" />
      <span>apps.apple.com</span><span>Thing — a new Mac app</span>
    </a>
  </div>
  <div role="group">
    <button data-testid="reply"><span>14</span></button>
    <button data-testid="retweet"><span>86</span></button>
    <button data-testid="like"><span>1.2K</span></button>
  </div>
</article>`;

/** A post whose media is a video, and which quotes another post. */
const X_VIDEO_QUOTE = `
<article data-testid="tweet">
  <div data-testid="User-Name"><span>Ada</span><span>@ada</span></div>
  <a href="/ada/status/42" role="link"><time datetime="2026-08-02T08:00:00.000Z">1d</time></a>
  <div data-testid="tweetText"><span>Watch this.</span></div>
  <video poster="https://pbs.twimg.com/ext_tw_video_thumb/1/img/p.jpg" src="blob:https://x.com/9f2"></video>
  <div role="link" tabindex="0">
    <div data-testid="User-Name"><span>Grace H</span><span>@grace</span></div>
    <div data-testid="tweetText"><span>The original point.</span></div>
  </div>
</article>`;

function render(html: string): Element {
  document.body.innerHTML = html;
  const post = document.querySelector("article[data-testid='tweet']");
  if (!post) throw new Error("fixture did not render");
  return post;
}

/**
 * jsdom reports naturalWidth 0 for every image, which the adapter reads to
 * skip avatars and emoji. Sizes are stamped on so the filter sees what a real
 * browser would.
 */
function sizeImages(scope: Element, sizes: Record<string, [number, number]>) {
  for (const img of scope.querySelectorAll("img")) {
    const match = Object.entries(sizes).find(([fragment]) => img.getAttribute("src")?.includes(fragment));
    const [width, height] = match ? match[1] : [0, 0];
    Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
    Object.defineProperty(img, "currentSrc", { value: img.getAttribute("src") ?? "", configurable: true });
  }
}

describe("the X adapter", () => {
  let adapters: ReturnType<typeof loadAdapters>;

  beforeEach(() => {
    // The document is served from x.com (see the docblock above), so relative
    // permalinks resolve the way they do in a timeline.
    adapters = loadAdapters();
  });

  it("claims x.com and twitter.com, and nothing else", () => {
    expect(adapters.adapterForHost("x.com")?.id).toBe("x");
    expect(adapters.adapterForHost("www.twitter.com")?.id).toBe("x");
    expect(adapters.adapterForHost("news.ycombinator.com")).toBeNull();
  });

  it("puts the button in the action row, next to reply and like", () => {
    const post = render(X_POST);
    const anchor = adapters.adapterForHost("x.com")!.anchorFor(post);
    expect(anchor?.getAttribute("role")).toBe("group");
  });

  describe("on a launch post that is a tagline plus a shortener", () => {
    let result: ExtractedPost;

    beforeEach(() => {
      const post = render(X_POST);
      sizeImages(post, { card_img: [800, 418], profile_images: [48, 48] });
      result = adapters.adapterForHost("x.com")!.extract(post);
    });

    it("files it under the post's own permalink, not the page URL", () => {
      expect(result.url).toBe("https://x.com/jane/status/1874");
    });

    it("reads the author, the handle and the time", () => {
      expect(result.author).toBe("Jane Doe");
      expect(result.authorHandle).toBe("@jane");
      expect(result.publishedAt).toBe("2026-09-01T10:00:00.000Z");
    });

    it("reads the text without the timeline's furniture", () => {
      expect(result.text).toContain("Launch pointer for a new Mac app.");
      expect(result.text).not.toContain("·");
    });

    it("keeps the card picture at full size and skips the avatar", () => {
      expect(result.media).toHaveLength(1);
      expect(result.media[0].url).toBe("https://pbs.twimg.com/card_img/999?format=jpg&name=large");
      expect(result.media[0].kind).toBe("image");
    });

    it("captures where the shortener actually goes — the point of the whole thing", () => {
      const destinations = result.links.map((link) => link.title ?? link.display);
      expect(destinations.join(" ")).toContain("apps.apple.com");
      expect(result.links.every((link) => link.url.startsWith("https://t.co/"))).toBe(true);
    });

    it("reads the counts as the feed abbreviates them", () => {
      expect(result.stats).toEqual({ replies: 14, reposts: 86, likes: 1200 });
    });
  });

  describe("on a video post that quotes another", () => {
    let result: ExtractedPost;

    beforeEach(() => {
      const post = render(X_VIDEO_QUOTE);
      sizeImages(post, {});
      result = adapters.adapterForHost("x.com")!.extract(post);
    });

    it("keeps the poster frame, since the stream itself is not fetchable", () => {
      expect(result.media).toHaveLength(1);
      expect(result.media[0].kind).toBe("video");
      expect(result.media[0].poster).toBe("https://pbs.twimg.com/ext_tw_video_thumb/1/img/p.jpg");
      // A blob: source belongs to the player and would 404 for anyone else.
      expect(result.media[0].url).toBeNull();
    });

    it("carries the quoted post with its author", () => {
      expect(result.quoted).toMatchObject({ authorHandle: "@grace", text: "The original point." });
    });

    it("does not fold the quoted text into the post's own", () => {
      expect(result.text).toBe("Watch this.");
    });
  });
});
