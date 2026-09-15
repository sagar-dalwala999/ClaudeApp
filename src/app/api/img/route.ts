/**
 * GET /api/img?key=…&v=card
 *
 * Serves archived pictures out of our own storage. Only keys we wrote are
 * served — there is no remote-URL proxy here, deliberately, because that would
 * be an SSRF hole and because the whole point of the media pipeline is that
 * the bytes are ours.
 */
import { readStoredMedia } from "@/server/media/pipeline";
import { badRequest, handle, notFound, requireApiUser } from "@/server/http/respond";
import { enumField, queryString } from "@/server/http/validate";

export const dynamic = "force-dynamic";

const VARIANTS = ["card", "full", "original"] as const;

export const GET = handle(async ({ url }) => {
  await requireApiUser();

  const key = queryString(url, "key", 400);
  if (!key) throw badRequest("key is required");
  const variant = enumField(queryString(url, "v", 20), VARIANTS, "v") ?? "card";

  const found = await readStoredMedia(key, variant);
  if (!found) throw notFound("No stored media for that key");

  return new Response(new Uint8Array(found.body), {
    headers: {
      "content-type": found.contentType,
      // Variants are written once and never rewritten.
      "cache-control": "private, max-age=31536000, immutable",
      "content-length": String(found.body.byteLength),
    },
  });
});
