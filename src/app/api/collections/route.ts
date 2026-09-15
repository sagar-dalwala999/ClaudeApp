/**
 * GET  /api/collections — list with counts, plus the items that fill each
 *                         sidebar thumbnail strip (one request, so the sidebar
 *                         never fires a query per row)
 * POST /api/collections — create
 */
import { getItems, listItems } from "@/server/db/queries/items";
import { createCollection, listCollectionPreviews, listCollections } from "@/server/db/queries/library";
import { badRequest, handle, json, readJson, requireApiUser } from "@/server/http/respond";
import { requiredString } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await requireApiUser();
  const collections = await listCollections(user.id);

  const pairs = await listCollectionPreviews(user.id).catch(() => []);
  const uniqueIds = [...new Set(pairs.map((pair) => pair.itemId))];
  const records = await getItems(user.id, uniqueIds);
  const byId = new Map(records.map((record) => [record.id, record]));

  const previews: Record<string, typeof records> = {};
  for (const pair of pairs) {
    const record = byId.get(pair.itemId);
    if (!record) continue;
    (previews[pair.collectionId] ??= []).push(record);
  }

  const recent = (await listItems({ userId: user.id, limit: 12 })).items;

  return json({ collections, previews, recent });
});

export const POST = handle(async ({ req }) => {
  const user = await requireApiUser();
  const body = await readJson(req);
  const name = requiredString(body.name, "name", 120);
  if (name.length < 1) throw badRequest("Collection name cannot be empty");
  const collection = await createCollection(user.id, name);
  return json({ collection }, { status: 201 });
});
