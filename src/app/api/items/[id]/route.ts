/**
 * GET    /api/items/:id  — one item
 * PATCH  /api/items/:id  — note, title, tags, type, status, favourite
 * DELETE /api/items/:id  — remove the item and its stored media
 *
 * A hand-edited title is marked `source = "manual"`, which stops the AI from
 * overwriting it later.
 */
import { deleteItem, getItem, getItemContent, removeFromCollection, addToCollection, setItemTags, updateItem } from "@/server/db/queries/items";
import { handle, json, notFound, readJson, requireApiUser } from "@/server/http/respond";
import { enumField, optionalBoolean, optionalString, stringArrayField } from "@/server/http/validate";
import { getStorage } from "@/server/media/storage";
import { ITEM_STATUSES, ITEM_TYPES } from "@/lib/vocab";
import type { CaptureLink } from "@/server/resolve/captureAssets";

export const dynamic = "force-dynamic";

/**
 * The parts of a capture worth showing back: where the post's links actually
 * went, who it quoted. Stored as free-form JSON, so it is read defensively.
 */
function readCaptureMeta(og: unknown): { links: CaptureLink[]; quoted: unknown } | null {
  if (!og || typeof og !== "object" || Array.isArray(og)) return null;
  const meta = og as Record<string, unknown>;
  if (meta.captured !== true) return null;
  const links = Array.isArray(meta.links)
    ? (meta.links as CaptureLink[]).filter((link) => link && typeof link.url === "string")
    : [];
  if (!links.length && !meta.quoted) return null;
  return { links, quoted: meta.quoted ?? null };
}

export const GET = handle(async ({ params }) => {
  const user = await requireApiUser();
  const item = await getItem(user.id, params.id);
  if (!item) throw notFound("No such item");
  // Only the detail view needs this, so it is one extra read here rather than
  // a join on every list query.
  const content = await getItemContent(item.id);
  return json({ item, capture: readCaptureMeta(content?.og) });
});

export const PATCH = handle(async ({ req, params }) => {
  const user = await requireApiUser();
  const body = await readJson(req);
  const existing = await getItem(user.id, params.id);
  if (!existing) throw notFound("No such item");

  const title = optionalString(body.title, "title", 500);
  const patch: Parameters<typeof updateItem>[2] = {
    title,
    summary: optionalString(body.summary, "summary", 5000),
    note: optionalString(body.note, "note", 10_000),
    type: enumField(body.type, ITEM_TYPES, "type"),
    status: enumField(body.status, ITEM_STATUSES, "status"),
    favorite: optionalBoolean(body.favorite, "favorite"),
  };
  if (title !== undefined) {
    // The owner has spoken: this title is final.
    patch.source = "manual";
    patch.ai = false;
  }

  const updated = await updateItem(user.id, params.id, patch);
  if (!updated) throw notFound("No such item");

  const tags = stringArrayField(body.tags, "tags", 24, 60);
  let final = updated;
  if (tags) {
    await setItemTags(user.id, params.id, tags, "user");
    final = (await getItem(user.id, params.id)) ?? updated;
  }

  if (body.collectionId !== undefined) {
    const collectionId = optionalString(body.collectionId, "collectionId", 60);
    const current = final.collections.map((c) => c.id);
    for (const id of current) {
      if (id !== collectionId) await removeFromCollection(id, params.id);
    }
    if (collectionId && !current.includes(collectionId)) await addToCollection(collectionId, params.id);
    final = (await getItem(user.id, params.id)) ?? final;
  }

  return json({ item: final });
});

export const DELETE = handle(async ({ params }) => {
  const user = await requireApiUser();
  const existing = await getItem(user.id, params.id);
  if (!existing) throw notFound("No such item");

  // Best effort: the row is the source of truth, orphaned files are harmless.
  const storage = getStorage();
  for (const media of existing.media) {
    if (!media.storageKey) continue;
    await storage.delete(media.storageKey).catch(() => undefined);
    await storage.delete(media.storageKey.replace(/-(card|full)(\.[a-z0-9]+)$/i, "-full$2")).catch(() => undefined);
  }

  await deleteItem(user.id, params.id);
  return json({ deleted: true });
});
