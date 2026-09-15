/**
 * Media pipeline: remote URL → downloaded bytes → WebP variants → storage.
 *
 * Runs as its own job so a slow host or a broken image cannot hold up the
 * resolve or enrich steps. Failures are per-image and never fail the item.
 */
import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { setMediaStorage } from "../db/queries/items";
import { itemMedia } from "../db/schema";
import { createSemaphore } from "../limits/rateLimit";
import { fetchBytes } from "../net/fetch";
import { getStorage, mediaKeyPrefix, safeKey } from "./storage";
import { encodeImage, sniffImageFormat } from "./transcode";

/** Pictures kept per item; the rest are dropped rather than half-processed. */
export const MAX_MEDIA_PER_ITEM = 4;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const downloadSemaphore = createSemaphore(3);

export interface MediaProcessingResult {
  stored: number;
  skipped: number;
  errors: string[];
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  return downloadSemaphore.run(async () => {
    const res = await fetchBytes(url, {
      maxBytes: MAX_DOWNLOAD_BYTES,
      timeoutMs: 20_000,
      maxRedirects: 4,
      accept: "image/*,*/*;q=0.5",
      // Some CDNs only serve the real image to a browser-ish Accept header.
      headers: { referer: "" },
    });
    if (!res.ok || !res.buffer.length) return null;
    if (res.truncated) return null;
    const contentType = res.contentType.split(";")[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") return null;
    return { buffer: res.buffer, contentType: contentType || "image/jpeg" };
  });
}

interface StoredVariants {
  prefix: string;
  cardKey: string;
  fullKey: string | null;
  width: number;
  height: number;
  bytes: number;
  placeholder: string | null;
}

async function storeVariants(itemId: string, mediaId: string, buffer: Buffer): Promise<StoredVariants> {
  const storage = getStorage();
  const prefix = safeKey(mediaKeyPrefix(itemId, mediaId));
  const encoded = await encodeImage(buffer);

  if (!encoded) {
    // No sharp: keep the original bytes so the archive still has the picture.
    const format = sniffImageFormat(buffer) ?? "jpeg";
    const key = `${prefix}-original.${format}`;
    const contentType = format === "jpeg" ? "image/jpeg" : `image/${format}`;
    const stored = await storage.put(key, buffer, contentType);
    return { prefix, cardKey: key, fullKey: key, width: 0, height: 0, bytes: stored.bytes, placeholder: null };
  }

  let bytes = 0;
  let cardKey: string | null = null;
  let fullKey: string | null = null;

  for (const variant of encoded.variants) {
    const key = `${prefix}-${variant.label}.webp`;
    const stored = await storage.put(key, variant.buffer, variant.contentType);
    bytes += stored.bytes;
    if (variant.label === "card") cardKey = key;
    if (variant.label === "full") fullKey = key;
  }

  return {
    prefix,
    cardKey: cardKey ?? fullKey ?? `${prefix}-card.webp`,
    fullKey,
    width: encoded.width,
    height: encoded.height,
    bytes,
    placeholder: encoded.placeholder,
  };
}

/** Downloads and stores every media row for an item that still needs it. */
export async function processItemMedia(itemId: string): Promise<MediaProcessingResult> {
  const db = getDb();
  const rows = await db.select().from(itemMedia).where(eq(itemMedia.itemId, itemId)).orderBy(asc(itemMedia.position));

  const result: MediaProcessingResult = { stored: 0, skipped: 0, errors: [] };
  const candidates = rows.filter((row) => !row.storageKey && row.remoteUrl).slice(0, MAX_MEDIA_PER_ITEM);

  // Media beyond the cap would only ever render as a broken card.
  const excess = rows.filter((row) => !row.storageKey && !row.remoteUrl).slice(MAX_MEDIA_PER_ITEM);
  if (excess.length) {
    for (const row of excess) await db.delete(itemMedia).where(eq(itemMedia.id, row.id));
  }

  const updates: Array<{
    id: string;
    storageKey: string;
    width: number | null;
    height: number | null;
    bytes: number | null;
    placeholder: string | null;
  }> = [];

  for (const row of candidates) {
    try {
      const downloaded = await downloadImage(row.remoteUrl!);
      if (!downloaded) {
        result.skipped += 1;
        continue;
      }
      const stored = await storeVariants(itemId, row.id, downloaded.buffer);
      updates.push({
        id: row.id,
        storageKey: stored.cardKey,
        width: stored.width || row.width,
        height: stored.height || row.height,
        bytes: stored.bytes,
        placeholder: stored.placeholder,
      });
      result.stored += 1;
    } catch (err) {
      result.errors.push(`${row.remoteUrl}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      result.skipped += 1;
    }
  }

  if (updates.length) await setMediaStorage(itemId, updates);
  return result;
}

/**
 * Stores bytes pushed to us directly by the extension, which is the only way
 * to archive a logged-in Instagram picture.
 */
export async function storeCapturedImage(input: {
  itemId: string;
  mediaId: string;
  base64: string;
  contentType: string;
}): Promise<{ storageKey: string; width: number; height: number; bytes: number; placeholder: string | null } | null> {
  const buffer = Buffer.from(input.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!buffer.length) return null;
  const stored = await storeVariants(input.itemId, input.mediaId, buffer);
  await setMediaStorage(input.itemId, [
    {
      id: input.mediaId,
      storageKey: stored.cardKey,
      width: stored.width,
      height: stored.height,
      bytes: stored.bytes,
      placeholder: stored.placeholder,
    },
  ]);
  return {
    storageKey: stored.cardKey,
    width: stored.width,
    height: stored.height,
    bytes: stored.bytes,
    placeholder: stored.placeholder,
  };
}

/** Reads a stored variant back for the image proxy route. */
export async function readStoredMedia(key: string, variant: "card" | "full" | "original" = "card"): Promise<{ body: Buffer; contentType: string } | null> {
  const storage = getStorage();
  const safe = safeKey(key);
  if (variant === "original") return storage.get(safe);
  // `key` is the stored variant path; swap the suffix when a different size is asked for.
  const target = safe.replace(/-(card|full|original)(\.[a-z0-9]+)$/i, `-${variant}$2`);
  const direct = await storage.get(target);
  if (direct) return direct;
  return storage.get(safe);
}
