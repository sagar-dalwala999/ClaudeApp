import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  extractReadableText,
  htmlToText,
  looksLikeSiteChrome,
  parseHtmlMeta,
  readableAuthorName,
  titleFromSlug,
  titleFromText,
  truncateText,
  wordCount,
} from "@/server/text/html";

describe("decodeEntities", () => {
  it("handles named, decimal and hex entities", () => {
    expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&mdash;")).toBe("—");
    expect(decodeEntities("a&nbsp;b")).toBe("a b");
  });

  it("leaves unknown entities and bare ampersands alone", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
    expect(decodeEntities("this and that")).toBe("this and that");
  });

  it("does not decode twice", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });
});

describe("htmlToText", () => {
  it("keeps the prose and drops the machinery", () => {
    const html = `
      <html><head><title>t</title><style>p{color:red}</style></head>
      <body>
        <nav>Home About</nav>
        <p>Hello <b>world</b></p>
        <script>var x = 1;</script>
        <p>Second &amp; third</p>
        <footer>© 2026</footer>
      </body></html>`;

    const text = htmlToText(html);
    expect(text).toContain("Hello world");
    expect(text).toContain("Second & third");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("color:red");
  });

  it("turns block elements into line breaks and collapses the blank ones", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
  });

  it("is a no-op on plain text", () => {
    expect(htmlToText("just words")).toBe("just words");
  });
});

describe("parseHtmlMeta", () => {
  const page = `<!doctype html>
    <html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="Real title">
      <meta property="og:description" content="What it is.">
      <meta property="og:site_name" content="Example Blog">
      <meta property="og:type" content="article">
      <meta property="og:image" content="/media/cover.png">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
      <meta property="article:published_time" content="2026-03-04T10:00:00Z">
      <meta name="twitter:creator" content="@ada">
      <link rel="canonical" href="/posts/real-title">
      <link rel="alternate" type="application/json+oembed" href="https://publish.example.com/oembed?url=x">
      <script type="application/ld+json">{"@type":"Article","author":{"name":"Ada Lovelace"},"datePublished":"2026-03-04T09:00:00Z"}</script>
    </head><body></body></html>`;

  const meta = parseHtmlMeta(page, "https://example.com/some/entry");

  it("prefers open graph over the title tag", () => {
    expect(meta.title).toBe("Real title");
    expect(meta.description).toBe("What it is.");
    expect(meta.siteName).toBe("Example Blog");
    expect(meta.ogType).toBe("article");
  });

  it("absolutises relative URLs against the page", () => {
    expect(meta.image).toBe("https://example.com/media/cover.png");
    expect(meta.canonical).toBe("https://example.com/posts/real-title");
    expect(meta.oembedHref).toBe("https://publish.example.com/oembed?url=x");
  });

  it("carries the image dimensions so the grid can place it before download", () => {
    expect(meta.imageWidth).toBe(1200);
    expect(meta.imageHeight).toBe(630);
  });

  it("reads the author and date, including from JSON-LD", () => {
    expect(meta.author).toBe("ada");
    expect(meta.publishedAt?.toISOString()).toBe("2026-03-04T10:00:00.000Z");
    expect(meta.jsonLd).toHaveLength(1);
  });

  it("returns nulls instead of throwing on an empty document", () => {
    const empty = parseHtmlMeta("");
    expect(empty.title).toBeNull();
    expect(empty.canonical).toBeNull();
    expect(empty.publishedAt).toBeNull();
    expect(empty.jsonLd).toEqual([]);
  });

  it("survives a malformed JSON-LD block", () => {
    const broken = parseHtmlMeta(`<script type="application/ld+json">{ not json }</script>`);
    expect(broken.jsonLd).toEqual([]);
  });
});

describe("extractReadableText", () => {
  const filler = "Sentence about the topic. ".repeat(30);

  it("uses a schema.org articleBody when the page publishes one", () => {
    const html = `<body><article><p>short</p></article></body>`;
    const meta = parseHtmlMeta(`<script type="application/ld+json">{"articleBody":${JSON.stringify(filler)}}</script>`);
    const result = extractReadableText(html, meta);
    expect(result.strategy).toBe("json-ld");
    expect(result.text.length).toBeGreaterThan(400);
  });

  it("picks the largest article element", () => {
    const html = `<body><article><p>${filler}</p></article><article><p>tiny</p></article></body>`;
    const result = extractReadableText(html);
    expect(result.strategy).toBe("article");
    expect(result.text).toContain("Sentence about the topic.");
  });

  it("falls back to main, then to the cleaned body", () => {
    expect(extractReadableText(`<body><main><p>${filler}</p></main></body>`).strategy).toBe("main");
    const body = extractReadableText(`<body><nav>menu</nav><p>${filler}</p></body>`);
    expect(body.strategy).toBe("body");
    expect(body.text).not.toContain("menu");
  });
});

describe("scholarly pages", () => {
  // arXiv, preprints, journals and PDFs use Google Scholar tags, not Open Graph.
  const paper = `<html><head>
    <title>[1706.03762] Preprint</title>
    <meta name="citation_title" content="Attention Is All You Need">
    <meta name="citation_author" content="Vaswani, Ashish">
    <meta name="citation_author" content="Shazeer, Noam">
    <meta name="citation_date" content="2017/06/12">
  </head><body></body></html>`;

  it("takes the title, the first author and the date from citation tags", () => {
    const meta = parseHtmlMeta(paper);
    expect(meta.title).toBe("Attention Is All You Need");
    expect(meta.author).toBe("Ashish Vaswani et al.");
    expect(meta.publishedAt?.getFullYear()).toBe(2017);
  });

  it("leaves the author alone when there is only one", () => {
    const single = parseHtmlMeta(`<meta name="citation_author" content="Knuth, Donald">`);
    expect(single.author).toBe("Donald Knuth");
  });

  it("still prefers open graph when a page has both", () => {
    const both = parseHtmlMeta(`
      <meta property="og:title" content="Site title">
      <meta name="citation_title" content="Paper title">`);
    expect(both.title).toBe("Site title");
  });
});

describe("readableAuthorName", () => {
  it("turns `Last, First` into a name a card can show", () => {
    expect(readableAuthorName("Vaswani, Ashish")).toBe("Ashish Vaswani");
    expect(readableAuthorName("Shazeer,  Noam")).toBe("Noam Shazeer");
  });

  it("leaves anything else as it found it", () => {
    expect(readableAuthorName("Ada Lovelace")).toBe("Ada Lovelace");
    expect(readableAuthorName("jack")).toBe("jack");
    expect(readableAuthorName("a, b, c")).toBe("a, b, c");
  });
});

describe("looksLikeSiteChrome", () => {
  it("recognises the logos that platforms publish as og:image", () => {
    expect(looksLikeSiteChrome("https://arxiv.org/static/browse/0.3.4/images/arxiv-logo-fb.png")).toBe(true);
    expect(looksLikeSiteChrome("https://example.com/favicon.ico")).toBe(true);
    expect(looksLikeSiteChrome("https://example.com/static/site_icon.png")).toBe(true);
  });

  it("keeps real pictures, including generated social cards", () => {
    expect(looksLikeSiteChrome("https://example.com/media/cover.png")).toBe(false);
    expect(looksLikeSiteChrome("https://opengraph.githubassets.com/1/vercel/next.js")).toBe(false);
    expect(looksLikeSiteChrome("https://cdn.example.com/catalog/bannerless-photo.jpg")).toBe(false);
    expect(looksLikeSiteChrome("not a url/logo.png")).toBe(true);
  });
});

describe("title helpers", () => {
  it("turns a slug into a presentable title", () => {
    expect(titleFromSlug("my-post")).toBe("My post");
    expect(titleFromSlug("hello.html")).toBe("Hello");
    expect(titleFromSlug("")).toBe("");
  });

  it("trims at a word boundary with an ellipsis", () => {
    expect(truncateText("the quick brown fox jumps over the lazy dog", 20)).toBe("the quick brown fox…");
    expect(truncateText("short", 20)).toBe("short");
  });

  it("takes the first sentence of a post as its provisional title", () => {
    expect(titleFromText("First line. Second sentence.\nmore")).toBe("First line.");
    expect(titleFromText("")).toBe("");
  });

  it("counts words the way a reader would", () => {
    expect(wordCount("Hello, world! It's a test.")).toBe(5);
    expect(wordCount("   ")).toBe(0);
  });
});
