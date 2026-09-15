/**
 * Captures pushed to us from outside: the browser extension, an iOS Shortcut,
 * the PWA share target.
 *
 * This is the only path that can read a logged-in Instagram or X page, because
 * the person is already looking at it in their own browser. Nothing here is
 * scraped behind their back — the payload is exactly what their browser sends.
 *
 * Two shapes arrive on this endpoint:
 *
 *   kind: "page"  the whole tab, one picture      (the toolbar button)
 *   kind: "post"  one post in a feed, every asset (the per-post button)
 *
 * A post capture carries what no server-side fetch can get: the text as
 * rendered, every image and video in the post, and the outbound links with
 * their shorteners already expanded by the page itself.
 */
import { z } from "zod";
import { isItemType, type ItemType } from "../../lib/vocab";
import { badRequest } from "../http/respond";
import type { NormalizedUrl } from "../normalize/url";
import { titleFromText } from "../text/html";
import { BODY_TEXT_LIMIT, capJsonForStorage, clampText, HTML_LIMIT, SUMMARY_LIMIT, TITLE_LIMIT } from "../text/size";
import { normalizeTags } from "../text/tags";
import {
  composeCaptureText,
  normalizeCaptureAssets,
  normalizeCaptureLinks,
  type CaptureAsset,
  type CaptureLink,
} from "./captureAssets";
import type { ResolvedContent } from "./types";

/** Cap on an inline image: 8 MB of bytes, base64 inflates by ~4/3. */
export const MAX_CAPTURE_IMAGE_BYTES = 8 * 1024 * 1024;
const BASE64_LIMIT = Math.ceil((MAX_CAPTURE_IMAGE_BYTES * 4) / 3) + 512;

/** Assets accepted per capture; the pipeline stores fewer, the rest are counted. */
const MAX_ASSETS_IN = 12;

const assetSchema = z.object({
  kind: z.enum(["image", "video"]).optional(),
  url: z.string().max(4000).optional(),
  base64: z.string().max(BASE64_LIMIT).optional(),
  contentType: z.string().max(120).optional(),
  poster: z.string().max(4000).optional(),
  width: z.number().int().min(0).max(100_000).optional(),
  height: z.number().int().min(0).max(100_000).optional(),
  alt: z.string().max(2000).optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
});

const linkSchema = z.object({
  url: z.string().max(4000),
  /** What the post rendered in place of the URL, e.g. `apps.apple.com/…`. */
  display: z.string().max(300).optional(),
  title: z.string().max(300).optional(),
});

export const captureSchema = z.object({
  url: z.string().min(3).max(4000),
  /** "post" when the capture is one post out of a feed. */
  kind: z.enum(["page", "post"]).optional(),
  title: z.string().max(TITLE_LIMIT * 2).optional(),
  description: z.string().max(20_000).optional(),
  text: z.string().max(400_000).optional(),
  html: z.string().max(HTML_LIMIT * 3).optional(),
  author: z.string().max(300).optional(),
  authorHandle: z.string().max(120).optional(),
  avatarUrl: z.string().max(4000).optional(),
  siteName: z.string().max(200).optional(),
  language: z.string().max(20).optional(),
  publishedAt: z.string().max(80).optional(),
  capturedAt: z.string().max(80).optional(),
  type: z.string().max(20).optional(),
  tags: z.array(z.string().max(80)).max(25).optional(),
  /** Single-image form, kept for share sheets and the toolbar button. */
  imageUrl: z.string().max(4000).optional(),
  imageBase64: z.string().max(BASE64_LIMIT).optional(),
  imageContentType: z.string().max(120).optional(),
  /** Every asset in a post, in the order it was shown. */
  media: z.array(assetSchema).max(MAX_ASSETS_IN).optional(),
  /** Outbound links, already expanded past their shortener by the page. */
  links: z.array(linkSchema).max(20).optional(),
  quoted: z
    .object({
      url: z.string().max(4000).optional(),
      author: z.string().max(300).optional(),
      authorHandle: z.string().max(120).optional(),
      text: z.string().max(20_000).optional(),
    })
    .optional(),
  stats: z
    .object({
      replies: z.number().int().min(0).optional(),
      reposts: z.number().int().min(0).optional(),
      likes: z.number().int().min(0).optional(),
      views: z.number().int().min(0).optional(),
    })
    .optional(),
  platform: z.string().max(20).optional(),
});

export type CapturePayload = z.infer<typeof captureSchema>;

export function parseCapture(body: unknown): CapturePayload {
  const parsed = captureSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid capture payload", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  }
  return parsed.data;
}

/**
 * The same payload as an HTML form: an iOS Shortcut, an Android share sheet,
 * or the installed PWA's share target all send this. `image` is a file part,
 * everything else is a text part.
 */
export async function parseMultipartCapture(form: FormData): Promise<CapturePayload> {
  const text = (key: string): string | undefined => {
    const value = form.get(key);
    return typeof value === "string" && value.trim() ? value : undefined;
  };

  const payload: Record<string, unknown> = {
    url: text("url") ?? "",
    title: text("title"),
    // Share sheets use `text` for the shared body and `description` for a page
    // summary depending on the platform; accept both.
    description: text("description") ?? text("summary"),
    text: text("text"),
    html: text("html"),
    author: text("author"),
    authorHandle: text("authorHandle"),
    siteName: text("siteName"),
    language: text("language"),
    publishedAt: text("publishedAt"),
    type: text("type"),
    platform: text("platform"),
    imageUrl: text("imageUrl"),
  };

  const tags = text("tags");
  if (tags) payload.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);

  const file = form.get("image");
  if (file && typeof file === "object" && "arrayBuffer" in file) {
    const bytes = Buffer.from(await (file as File).arrayBuffer());
    if (bytes.length > MAX_CAPTURE_IMAGE_BYTES) throw badRequest("Image is larger than 8 MB");
    payload.imageBase64 = bytes.toString("base64");
    payload.imageContentType = (file as File).type || "image/jpeg";
  }

  return parseCapture(payload);
}

export interface CaptureResult {
  content: ResolvedContent;
  /** What to store, in order. Inline entries bypass the downloader entirely. */
  assets: CaptureAsset[];
  links: CaptureLink[];
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeHandle(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") || trimmed.startsWith("u/") ? trimmed : `@${trimmed}`;
}

/**
 * The single-image fields and the `media` array describe the same thing; a
 * post capture sends the array, everything older sends the fields. Merging
 * them here means one shape downstream.
 */
function collectRawAssets(payload: CapturePayload) {
  const raw = [...(payload.media ?? [])];
  if (payload.imageUrl || payload.imageBase64) {
    raw.unshift({
      kind: "image" as const,
      url: payload.imageUrl,
      base64: payload.imageBase64,
      contentType: payload.imageContentType,
    });
  }
  return raw;
}

export function captureToContent(payload: CapturePayload, input: NormalizedUrl, source: "extension" | "share"): CaptureResult {
  const isPost = payload.kind === "post";
  const links = normalizeCaptureLinks(payload.links);
  const { assets, dropped } = normalizeCaptureAssets(collectRawAssets(payload));

  const postText = (payload.text ?? payload.description ?? "").trim() || null;
  const bodyText = composeCaptureText({ text: postText, links, quoted: payload.quoted ?? null });

  // A post's first line is its title; a page has one in the <title> tag.
  const title = payload.title?.trim() || (postText ? titleFromText(postText, TITLE_LIMIT) : null);
  const type: ItemType = isItemType(payload.type) ? payload.type : input.typeHint;

  return {
    content: {
      title,
      summary: payload.description ? clampText(payload.description, SUMMARY_LIMIT) : null,
      // clampText, not truncateText: a post's own line breaks are part of
      // what was on the screen, and flattening them loses the shape of it.
      text: clampText(bodyText, BODY_TEXT_LIMIT),
      html: payload.html ? clampText(payload.html, HTML_LIMIT) : null,
      author: payload.author?.trim() || null,
      authorHandle: normalizeHandle(payload.authorHandle),
      siteName: payload.siteName?.trim() || null,
      language: payload.language?.trim().slice(0, 5) || null,
      publishedAt: parseDate(payload.publishedAt),
      type,
      tags: payload.tags ? normalizeTags(payload.tags) : [],
      media: assets.map((asset) => ({
        kind: asset.kind,
        remoteUrl: asset.remoteUrl ?? asset.posterUrl ?? "",
        width: asset.width,
        height: asset.height,
        alt: asset.alt ?? title,
        fallbackUrl: asset.posterUrl,
      })),
      url: input.url,
      meta: capJsonForStorage({
        source,
        kind: isPost ? "post" : "page",
        platform: payload.platform ?? input.platform,
        captured: true,
        capturedAt: payload.capturedAt ?? new Date().toISOString(),
        avatarUrl: payload.avatarUrl ?? null,
        links: links.length ? links : undefined,
        quoted: payload.quoted ?? undefined,
        stats: payload.stats ?? undefined,
        assetsDropped: dropped || undefined,
      }),
    },
    assets,
    links,
  };
}
