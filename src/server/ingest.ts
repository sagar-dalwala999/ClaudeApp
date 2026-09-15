/**
 * Ingestion: the one function every capture path goes through.
 *
 * Paste, browser extension, iOS Shortcut and CLI all land here, so
 * normalisation, shortener expansion, dedupe, collection filing and job
 * enqueueing behave identically no matter where the link came from.
 */
import { getItem, insertItem, replaceItemContent, replaceItemMedia, updateItem, type ItemRecord } from "./db/queries/items";
import { enqueue, QUEUE } from "./jobs/queue";
import { storeCapturedImage } from "./media/pipeline";
import { followRedirects } from "./net/fetch";
import { InvalidUrlError, normalizeUrlInput, type NormalizedUrl } from "./normalize/url";
import { captureToContent, type CapturePayload } from "./resolve/extension";
import { wordCount } from "./text/html";
import { BODY_TEXT_LIMIT, clampText, HTML_LIMIT, SUMMARY_LIMIT, TITLE_LIMIT } from "./text/size";
import type { ItemType } from "../lib/vocab";

/** Hosts whose only job is to redirect; worth one extra request to expand. */
const SHORTENERS = new Set([
  "t.co",
  "bit.ly",
  "buff.ly",
  "tinyurl.com",
  "ow.ly",
  "lnkd.in",
  "redd.it",
  "amzn.to",
  "amzn.eu",
  "fb.watch",
  "buff.ly",
  "trib.al",
  "shrtco.de",
  "is.gd",
  "v.gd",
  "s.id",
  "rb.gy",
  "shorturl.at",
  "urlz.fr",
  "t.ly",
]);

export interface IngestOptions {
  userId: string;
  /** Raw text the user pasted; a URL is extracted from it. */
  input: string;
  collectionId?: string | null;
  source?: string;
  /** Skip the automatically enqueued resolve job (used when data is pushed to us). */
  skipJobs?: boolean;
}

export interface IngestResult {
  item: ItemRecord;
  created: boolean;
  normalized: NormalizedUrl;
}

/** Expands a known shortener to its destination, best effort. */
export async function expandShortener(normalized: NormalizedUrl): Promise<NormalizedUrl> {
  const host = new URL(normalized.url).hostname;
  if (!SHORTENERS.has(host)) return normalized;
  try {
    const { url } = await followRedirects(normalized.url, { timeoutMs: 7000, maxRedirects: 5 });
    if (!url || url === normalized.url) return normalized;
    return normalizeUrlInput(url);
  } catch {
    return normalized;
  }
}

export async function ingestUrl(options: IngestOptions): Promise<IngestResult> {
  const initial = normalizeUrlInput(options.input);
  const normalized = await expandShortener(initial);

  const { item, created } = await insertItem({
    userId: options.userId,
    url: normalized.url,
    canonicalUrl: normalized.canonicalUrl,
    identityKey: normalized.identityKey,
    platform: normalized.platform,
    type: normalized.typeHint satisfies ItemType,
    status: "pending",
    source: options.source ?? null,
    collectionId: options.collectionId ?? null,
  });

  if (created && !options.skipJobs) {
    await enqueue(QUEUE.resolve, { itemId: item.id, userId: options.userId }, { singletonKey: item.id });
  }

  return { item, created, normalized };
}

export interface CaptureIngestOptions {
  userId: string;
  payload: CapturePayload;
  /** Where the bytes came from: the extension, or a share sheet / Shortcut. */
  source: "extension" | "share";
}

export interface CaptureIngestResult {
  item: ItemRecord;
  created: boolean;
  /**
   * True when the caller supplied its own content, in which case the resolver
   * chain is skipped and the item goes straight to enrichment. This is what
   * makes captures of gated Instagram posts work at all.
   */
  captured: boolean;
}

/**
 * Persist a capture that already carries its own content — the extension, an
 * iOS Shortcut, an Android share sheet. The captured image is authoritative:
 * it is the only copy of a picture the server could not fetch itself.
 */
export async function ingestCapture(options: CaptureIngestOptions): Promise<CaptureIngestResult> {
  const { userId, payload, source } = options;
  const normalized = normalizeUrlInput(payload.url);
  const { content, image } = captureToContent(payload, normalized, source);
  const captured = Boolean(content.title && (content.text || content.media?.length));

  const { item, created } = await insertItem({
    userId,
    url: normalized.url,
    canonicalUrl: normalized.canonicalUrl,
    identityKey: normalized.identityKey,
    platform: normalized.platform,
    type: content.type ?? normalized.typeHint,
    status: "pending",
    source,
  });

  const title = clampText(content.title ?? null, TITLE_LIMIT);
  const bodyText = clampText(content.text ?? null, BODY_TEXT_LIMIT);

  await updateItem(userId, item.id, {
    title: title ?? item.title,
    summary: clampText(content.summary ?? null, SUMMARY_LIMIT) ?? item.summary,
    author: content.author ?? item.author,
    authorHandle: content.authorHandle ?? item.authorHandle,
    siteName: content.siteName ?? item.siteName,
    language: content.language ?? item.language,
    publishedAt: content.publishedAt ?? (item.publishedAt ? new Date(item.publishedAt) : null),
    type: content.type ?? item.type,
    bodyText,
    source,
    status: "pending",
    lastError: null,
    fetchedAt: new Date(),
  });

  await replaceItemContent(item.id, {
    text: bodyText,
    html: clampText(content.html ?? null, HTML_LIMIT),
    og: null,
    wordCount: bodyText ? wordCount(bodyText) : 0,
    resolver: source,
  });

  if (image) {
    const mediaIds = await replaceItemMedia(item.id, [
      { kind: "image", remoteUrl: null, alt: title ?? null, width: null, height: null },
    ]);
    const mediaId = mediaIds[0];
    if (mediaId) {
      await storeCapturedImage({ itemId: item.id, mediaId, base64: image.base64, contentType: image.contentType }).catch(
        (err) => {
          console.warn(`[ingest] storing captured image failed: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
    }
  } else if (content.media?.length) {
    await replaceItemMedia(
      item.id,
      content.media.slice(0, 4).map((entry) => ({
        kind: entry.kind,
        remoteUrl: entry.remoteUrl,
        width: entry.width ?? null,
        height: entry.height ?? null,
        alt: entry.alt ?? title ?? null,
      })),
    );
  }

  if (captured) {
    await enqueue(QUEUE.enrich, { itemId: item.id }, { singletonKey: item.id });
  } else {
    // Thin capture: let the resolver chain try to fill the gaps first.
    await enqueue(QUEUE.resolve, { itemId: item.id, userId }, { singletonKey: item.id });
  }

  return { item: (await getItem(userId, item.id)) ?? item, created, captured };
}

export { InvalidUrlError };
