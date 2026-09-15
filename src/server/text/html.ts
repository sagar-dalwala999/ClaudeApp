/**
 * Small, dependency-free HTML helpers.
 *
 * Not a full parser — deliberately. We need three things from a fetched page:
 * the metadata in its head, a usable chunk of prose, and a title. Regex and
 * heuristics handle that deterministically, which makes it unit-testable
 * against fixtures, and avoid pulling a DOM implementation into the worker.
 * Anything fancier belongs in the AI step, which sees the text, not the tags.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  bull: "•",
  times: "×",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  deg: "°",
  laquo: "«",
  raquo: "»",
  shy: "",
  zwj: "",
  zwnj: "",
};

export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]{1,31});/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Elements whose contents are never prose. */
const DROPPED_ELEMENTS = /<(script|style|noscript|svg|template|iframe|canvas|form|figure)\b[^>]*>[\s\S]*?<\/\1>/gi;

const BLOCK_BOUNDARY =
  /<\/?(p|div|section|article|main|header|footer|aside|nav|ul|ol|li|table|tr|td|th|h[1-6]|blockquote|pre|figcaption|br|hr)\b[^>]*>/gi;

/** Visible text of an HTML fragment, with block elements as line breaks. */
export function htmlToText(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutDropped = withoutComments.replace(DROPPED_ELEMENTS, " ");
  const withBreaks = withoutDropped.replace(BLOCK_BOUNDARY, "\n");
  const stripped = withBreaks.replace(/<[^>]*>/g, " ");
  return tidyLines(decodeEntities(stripped));
}

function tidyLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]?.length))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PageMeta {
  title: string | null;
  description: string | null;
  siteName: string | null;
  author: string | null;
  canonical: string | null;
  oembedHref: string | null;
  image: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  locale: string | null;
  publishedAt: Date | null;
  ogType: string | null;
  openGraph: Record<string, string>;
  jsonLd: unknown[];
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag))) {
    const name = match[1].toLowerCase();
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function absolute(href: string | undefined, base: string | null): string | null {
  if (!href) return null;
  try {
    return base ? new URL(href, base).toString() : new URL(href).toString();
  } catch {
    return null;
  }
}

/**
 * `Vaswani, Ashish` → `Ashish Vaswani`, the way a card should read. Scholar
 * meta tags use `Last, First`; anything we cannot parse is left alone.
 */
export function readableAuthorName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const match = /^([^,]{1,80}),\s*([^,]{1,80})$/.exec(trimmed);
  return match ? `${match[2]} ${match[1]}` : trimmed;
}

/**
 * Site chrome that platforms publish as an `og:image`: a logo, an icon, a
 * favicon. A procedural placeholder is a better card than someone's banner,
 * so these are treated as "no picture" rather than downloaded.
 */
export function looksLikeSiteChrome(url: string): boolean {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep the raw value */
  }
  const file = path.split("/").pop() ?? "";
  return /(^|[-_.])(logo|logos|icon|icons|favicon|sprite|banner|placeholder)([-_.]|$)/i.test(file);
}

function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct;
  // Bare year, e.g. "2024"
  if (/^\d{4}$/.test(trimmed)) return new Date(Date.UTC(Number(trimmed), 0, 1));
  return null;
}

function findJsonLdAuthor(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const author = (node as Record<string, unknown>).author;
  if (typeof author === "string") return author;
  if (Array.isArray(author)) {
    for (const entry of author) {
      const name = findJsonLdAuthor({ author: entry });
      if (name) return name;
    }
    return null;
  }
  if (author && typeof author === "object") {
    const name = (author as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return null;
}

/** Pulls the metadata a link card needs out of a page's head. */
export function parseHtmlMeta(html: string, baseUrl: string | null = null): PageMeta {
  const openGraph: Record<string, string> = {};
  let title: string | null = null;
  // Scholarly pages (arXiv, preprints, journals, PDFs) publish Google Scholar
  // `citation_*` tags instead of Open Graph ones.
  let citationTitle: string | null = null;
  let citationDate: string | null = null;
  const citationAuthors: string[] = [];
  let description: string | null = null;
  let siteName: string | null = null;
  let author: string | null = null;
  let image: string | null = null;
  let imageWidth: number | null = null;
  let imageHeight: number | null = null;
  let locale: string | null = null;
  let published: string | null = null;
  let canonical: string | null = null;
  let oembedHref: string | null = null;

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) title = decodeEntities(titleTag[1]).trim() || null;

  const metaPattern = /<meta\b[^>]*>/gi;
  let meta: RegExpExecArray | null;
  while ((meta = metaPattern.exec(html))) {
    const attrs = parseAttributes(meta[0]);
    const key = (attrs.property ?? attrs.name ?? attrs["http-equiv"] ?? "").toLowerCase();
    const content = attrs.content;
    if (!key || content === undefined) continue;

    if (key.startsWith("og:")) openGraph[key.slice(3)] = content;
    switch (key) {
      case "og:title":
      case "twitter:title":
        if (!title || key === "og:title") title = content.trim() || title;
        break;
      case "description":
      case "og:description":
      case "twitter:description":
        if (!description) description = content.trim() || null;
        break;
      case "og:site_name":
      case "application-name":
        siteName = siteName ?? (content.trim() || null);
        break;
      case "author":
      case "article:author":
      case "og:article:author":
      case "twitter:creator":
        author = author ?? (content.trim().replace(/^@/, "") || null);
        break;
      case "og:image":
      case "og:image:url":
      case "twitter:image":
      case "twitter:image:src":
        image = image ?? (content.trim() || null);
        break;
      case "og:image:width":
        imageWidth = Number(content) || imageWidth;
        break;
      case "og:image:height":
        imageHeight = Number(content) || imageHeight;
        break;
      case "og:locale":
        locale = locale ?? (content.trim() || null);
        break;
      case "og:type":
        if (!openGraph.type) openGraph.type = content.trim();
        break;
      case "article:published_time":
      case "og:article:published_time":
        published = published ?? content.trim();
        break;
      case "twitter:card":
        openGraph.twittercard = content.trim();
        break;
      case "citation_title":
        citationTitle = citationTitle ?? (content.trim() || null);
        break;
      case "citation_author":
        if (content.trim() && citationAuthors.length < 12) citationAuthors.push(content.trim());
        break;
      case "citation_date":
        citationDate = citationDate ?? (content.trim() || null);
        break;
      default:
        break;
    }
  }

  // Precedence: og:title, then the scholar tag, then whatever <title> said.
  if (!openGraph.title && citationTitle) title = citationTitle;

  const linkPattern = /<link\b[^>]*>/gi;
  let link: RegExpExecArray | null;
  while ((link = linkPattern.exec(html))) {
    const attrs = parseAttributes(link[0]);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("canonical") && !canonical) canonical = attrs.href ?? null;
    if (rel.includes("alternate") && (attrs.type ?? "").includes("json+oembed") && !oembedHref) oembedHref = attrs.href ?? null;
  }

  const jsonLd: unknown[] = [];
  const ldPattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ld: RegExpExecArray | null;
  while ((ld = ldPattern.exec(html))) {
    const raw = ld[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    if (!raw || raw.length > 400_000) continue;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of list) {
        jsonLd.push(entry);
        if (entry && typeof entry === "object") {
          const node = entry as Record<string, unknown>;
          if (!author) author = findJsonLdAuthor(node);
          if (!published && typeof node.datePublished === "string") published = node.datePublished;
        }
      }
    } catch {
      /* malformed JSON-LD is common; ignore it */
    }
  }

  const firstAuthor = citationAuthors[0] ? readableAuthorName(citationAuthors[0]) : null;
  const authorName =
    author?.trim() || (firstAuthor ? (citationAuthors.length > 1 ? `${firstAuthor} et al.` : firstAuthor) : null);

  return {
    title: title?.trim() || null,
    description: description?.trim() || null,
    siteName: siteName?.trim() || null,
    author: authorName,
    canonical: absolute(canonical ?? undefined, baseUrl),
    oembedHref: absolute(oembedHref ?? undefined, baseUrl),
    image: absolute(image ?? openGraph.image ?? undefined, baseUrl),
    imageWidth,
    imageHeight,
    locale,
    publishedAt: parseDate(published ?? openGraph.published_time ?? citationDate),
    ogType: openGraph.type ?? null,
    openGraph,
    jsonLd,
  };
}

/** schema.org sometimes carries the whole article body, which beats scraping. */
function jsonLdArticleBody(jsonLd: unknown[]): string | null {
  for (const entry of jsonLd) {
    if (!entry || typeof entry !== "object") continue;
    const body = (entry as Record<string, unknown>).articleBody;
    if (typeof body === "string" && body.trim().length > 400) return body.trim();
  }
  return null;
}

export interface ReadableText {
  text: string;
  /** The fragment the text came from, for storage/debugging. */
  html: string | null;
  strategy: "json-ld" | "article" | "main" | "body";
}

function textOf(html: string): string {
  return htmlToText(html);
}

function pickContainer(html: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let best: string | null = null;
  let bestLength = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const candidate = match[1];
    const length = textOf(candidate).length;
    if (length > bestLength) {
      bestLength = length;
      best = candidate;
    }
  }
  return best;
}

/**
 * Best-effort main-content extraction, in descending order of confidence:
 * JSON-LD articleBody, the largest <article>, the largest <main>, then the
 * whole body with chrome removed.
 */
export function extractReadableText(html: string, meta?: PageMeta): ReadableText {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  const fromJsonLd = meta ? jsonLdArticleBody(meta.jsonLd) : null;
  if (fromJsonLd) return { text: tidyLines(fromJsonLd), html: null, strategy: "json-ld" };

  const article = pickContainer(body, "article");
  if (article && textOf(article).length > 300) {
    return { text: proseFrom(article), html: article.slice(0, 400_000), strategy: "article" };
  }

  const main = pickContainer(body, "main");
  if (main && textOf(main).length > 300) {
    return { text: proseFrom(main), html: main.slice(0, 400_000), strategy: "main" };
  }

  const cleaned = body
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const text = proseFrom(cleaned);
  return { text: text || textOf(body), html: cleaned.slice(0, 400_000), strategy: "body" };
}

/**
 * Keeps the prose paragraphs rather than every stray string, which is what
 * makes the text usable as an AI prompt.
 */
function proseFrom(fragment: string): string {
  const blocks: string[] = [];
  const pattern = /<(p|h2|h3|blockquote|li|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment))) {
    const text = textOf(match[2]);
    if (text.length >= 2) blocks.push(text);
  }
  const joined = tidyLines(blocks.join("\n\n"));
  if (joined.length >= 200) return joined;
  return textOf(fragment);
}

/** Turns a slug into something presentable: "my-post" → "My post". */
export function titleFromSlug(slug: string): string {
  const cleaned = decodeURIComponent(slug)
    .replace(/\.(html?|php|aspx?|md)$/i, "")
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Trims at a word boundary without leaving a dangling conjunction. */
export function truncateText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-–—]+$/, "");
  return `${base}…`;
}

export function wordCount(text: string): number {
  const words = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

/**
 * First meaningful line of a post, used as a provisional title for platforms
 * that only hand us text (X, Reddit selfposts).
 */
export function titleFromText(text: string, max = 90): string {
  const firstLine = text.split(/\n+/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s+/)[0] ?? firstLine;
  return truncateText(sentence, max);
}
