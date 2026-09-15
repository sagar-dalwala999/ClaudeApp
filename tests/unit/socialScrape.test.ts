import { describe, expect, it } from "vitest";
import { normalizeUrlInput } from "@/server/normalize/url";
import { contentFromScrapedReddit } from "@/server/resolve/reddit";
import { contentFromScrapedX } from "@/server/resolve/x";

describe("Scrape.do social HTML", () => {
  it("reads an X post from stable head metadata", () => {
    const html = `<!doctype html><html lang="en"><head>
      <title>Marcel Kargul (@marcelkargul): “this wasn’t a prompt” / X</title>
      <meta name="description" content="this wasn’t a prompt.&#10;&#10;- 7 hours of work">
      <meta property="og:image" content="https://pbs.twimg.com/media/post.webp">
      <meta property="og:image:width" content="1024">
      <meta property="og:image:height" content="720">
    </head><body><img alt="@marcelkargul" src="profile.webp">
      <video poster="https://pbs.twimg.com/media/post.webp"></video>
      <script>{"timestamp":1789246432000}</script>
    </body></html>`;

    const content = contentFromScrapedX(html, normalizeUrlInput("https://x.com/marcelkargul/status/2098877780293271731"));
    expect(content.title).toBe("this wasn’t a prompt.");
    expect(content.text).toContain("7 hours of work");
    expect(content.author).toBe("Marcel Kargul");
    expect(content.authorHandle).toBe("@marcelkargul");
    expect(content.language).toBe("en");
    expect(content.publishedAt?.toISOString()).toBe("2026-09-12T20:53:52.000Z");
    expect(content.media).toEqual([
      {
        kind: "video",
        remoteUrl: "https://pbs.twimg.com/media/post.webp",
        width: 1024,
        height: 720,
        alt: "this wasn’t a prompt.\n\n- 7 hours of work",
      },
    ]);
  });

  it("reads only the requested Reddit post and preserves its gallery", () => {
    const html = `<shreddit-post id="t3_decoy" post-title="Wrong post"><div property="schema:articleBody">Wrong body</div></shreddit-post>
      <shreddit-post id="t3_1weg2vp" post-title="Built my own Web UI" author="rvstybeard"
        subreddit-prefixed-name="r/hermesagent" created-timestamp="2026-09-12T15:50:21.648000+0000"
        permalink="/r/hermesagent/comments/1weg2vp/built_my_own_web_ui/" content-href="https://www.reddit.com/gallery/1weg2vp"
        comment-count="20" score="68" post-language="en" post-type="gallery">
        <h1 id="post-title-t3_1weg2vp">Built my own Web UI</h1>
        <img class="media-lightbox-img" src="https://preview.redd.it/one.jpg?width=640&amp;auto=webp" width="1170" height="2532">
        <img class="media-lightbox-img" data-lazy-src="https://preview.redd.it/two.jpg?width=640&amp;auto=webp" width="1170" height="2532">
        <img class="media-lightbox-img" src="https://preview.redd.it/one.jpg?width=640&amp;auto=webp" width="1170" height="2532">
        <div property="schema:articleBody"><p>Liked the desktop app but needed phone access.</p><p>Built my own PWA.</p></div>
      </shreddit-post>`;

    const content = contentFromScrapedReddit(
      html,
      normalizeUrlInput("https://www.reddit.com/r/hermesagent/comments/1weg2vp/built_my_own_web_ui/"),
    );
    expect(content?.title).toBe("Built my own Web UI");
    expect(content?.text).toBe("Liked the desktop app but needed phone access. Built my own PWA.");
    expect(content?.authorHandle).toBe("u/rvstybeard");
    expect(content?.siteName).toBe("r/hermesagent");
    expect(content?.publishedAt?.toISOString()).toBe("2026-09-12T15:50:21.648Z");
    expect(content?.canonical).toBe("https://www.reddit.com/r/hermesagent/comments/1weg2vp/built_my_own_web_ui/");
    expect(content?.media?.map((media) => media.remoteUrl)).toEqual([
      "https://preview.redd.it/one.jpg?width=640&auto=webp",
      "https://preview.redd.it/two.jpg?width=640&auto=webp",
    ]);
    expect(content?.meta).toMatchObject({ score: 68, comments: 20, external: null });
  });
});
