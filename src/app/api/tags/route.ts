/**
 * GET  /api/tags — the vocabulary, most used first
 * POST /api/tags — attach tags to an item (user-sourced, never overwritten)
 */
import { setItemTags } from "@/server/db/queries/items";
import { listTags } from "@/server/db/queries/library";
import { handle, json, notFound, readJson, requireApiUser } from "@/server/http/respond";
import { numberField, queryString, requiredString, stringArrayField } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = handle(async ({ url }) => {
  const user = await requireApiUser();
  const limit = numberField(queryString(url, "limit"), 400, 1, 1_000, "limit");
  return json({ tags: await listTags(user.id, limit) });
});

export const POST = handle(async ({ req }) => {
  const user = await requireApiUser();
  const body = await readJson(req);
  const itemId = requiredString(body.itemId, "itemId", 60);
  const tags = stringArrayField(body.tags, "tags", 24, 60);
  if (!tags) throw notFound('"tags" is required');
  const names = await setItemTags(user.id, itemId, tags, "user");
  return json({ tags: names });
});
