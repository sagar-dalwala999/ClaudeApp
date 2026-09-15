/**
 * Media handler.
 *
 * Downloads and re-encodes the pictures found by the resolver. Failures are
 * per-image and never fail the item: a link with a dead image is still a
 * useful link.
 */
import { processItemMedia } from "../../media/pipeline";

export interface MediaPayload {
  itemId: string;
}

export async function handleMedia(payload: MediaPayload): Promise<void> {
  const result = await processItemMedia(payload.itemId);
  if (result.errors.length) {
    console.warn(`[media] ${payload.itemId}: ${result.stored} stored, ${result.skipped} skipped`);
    for (const error of result.errors.slice(0, 3)) console.warn(`[media]   ${error}`);
  }
}
