/**
 * Captures pushed to us from outside: the browser extension, an iOS Shortcut,
 * the PWA share target.
 *
 * This is the only path that can read a logged-in Instagram or X page, because
 * the person is already looking at it in their own browser. Nothing here is
 * scraped behind their back — the payload is exactly what their browser sends.
 */
import { z } from "zod";
import { isItemType, type ItemType } from "../../lib/vocab";
import { badRequest } from "../http/respond";
import type { NormalizedUrl } from "../normalize/url";
import { titleFromText, truncateText } from "../text/html";
import { capJsonForStorage, clampText, HTML_LIMIT, SUMMARY_LIMIT, TITLE_LIMIT } from "../text/size";
import { normalizeTags } from "../text/tags";
import type { ResolvedContent } from "./types";

/** Cap on an inline image: 8 MB of bytes, base64 inflates by ~4/3. */
export const MAX_CAPTURE_IMAGE_BYTES = 8 * 1024 * 1024;
const BASE64_LIMIT = Math.ceil((MAX_CAPTURE_IMAGE_BYTES * 4) / 3) + 512;

export const captureSchema = z.object({
  url: z.string().min(3).max(4000),
  title: z.string().max(TITLE_LIMIT * 2).optional(),
  description: z.string().max(20_000).optional(),
  text: z.string().max(400_000).optional(),
  html: z.string().max(HTML_LIMIT * 3).optional(),
  author: z.string().max(300).optional(),
  authorHandle: z.string().max(120).optional(),
  siteName: z.string().max(200).optional(),
  language: z.string().max(20).optional(),
  publishedAt: z.string().max(80).optional(),
  type: z.string().max(20).optional(),
  tags: z.array(z.string().max(80)).max(25).optional(),
  imageUrl: z.string().max(4000).optional(),
  imageBase64: z.string().max(BASE64_LIMIT).optional(),
  imageContentType: z.string().max(120).optional(),
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

export interface CaptureImage {
  base64: string;
  contentType: string;
  alt: string | null;
}

export interface CaptureResult {
  content: ResolvedContent;
  /** Inline image bytes the caller writes to storage, bypassing the downloader. */
  image: CaptureImage | null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeHandle(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") || trimmed.startsWith("u/") ? trimmed : `@${trimmed}`;
}

export function captureToContent(payload: CapturePayload, input: NormalizedUrl, source: "extension" | "share"): CaptureResult {
  const bodyText = (payload.text ?? payload.description ?? "").trim();
  const title = payload.title?.trim() || (bodyText ? titleFromText(bodyText, TITLE_LIMIT) : null);

  const type: ItemType = isItemType(payload.type) ? payload.type : input.typeHint;

  const inlineImage = payload.imageBase64 && payload.imageBase64.length > 32 ? payload.imageBase64 : null;
  const contentType = payload.imageContentType?.startsWith("image/") ? payload.imageContentType : "image/jpeg";

  return {
    content: {
      title,
      summary: payload.description ? clampText(payload.description, SUMMARY_LIMIT) : null,
      text: bodyText ? truncateText(bodyText, 20_000) : null,
      html: payload.html ? clampText(payload.html, HTML_LIMIT) : null,
      author: payload.author?.trim() || null,
      authorHandle: normalizeHandle(payload.authorHandle),
      siteName: payload.siteName?.trim() || null,
      language: payload.language?.trim().slice(0, 5) || null,
      publishedAt: parseDate(payload.publishedAt),
      type,
      tags: payload.tags ? normalizeTags(payload.tags) : [],
      media: payload.imageUrl ? [{ kind: "image", remoteUrl: payload.imageUrl, alt: title }] : [],
      url: input.url,
      meta: capJsonForStorage({ source, platform: payload.platform ?? input.platform, captured: true }),
    },
    image: inlineImage ? { base64: inlineImage, contentType, alt: title } : null,
  };
}
