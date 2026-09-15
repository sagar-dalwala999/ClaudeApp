/**
 * POST   /api/collections/:id/items  — file an item into a collection
 * DELETE /api/collections/:id/items  — remove it
 */
import { addToCollection, getItem, removeFromCollection } from "@/server/db/queries/items";
import { handle, json, notFound, readJson, requireApiUser } from "@/server/http/respond";
import { queryString, requiredString } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = handle(async ({ req, params }) => {
  const user = await requireApiUser();
  const body = await readJson(req);
  const itemId = requiredString(body.itemId, "itemId", 60);
  const item = await getItem(user.id, itemId);
  if (!item) throw notFound("No such item");
  await addToCollection(params.id, itemId);
  return json({ added: true });
});

export const DELETE = handle(async ({ params, url }) => {
  const user = await requireApiUser();
  const itemId = queryString(url, "itemId", 60);
  if (!itemId) throw notFound("itemId is required");
  const item = await getItem(user.id, itemId);
  if (!item) throw notFound("No such item");
  await removeFromCollection(params.id, itemId);
  return json({ removed: true });
});
