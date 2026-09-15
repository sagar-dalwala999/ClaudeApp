/**
 * PATCH  /api/collections/:id — rename
 * DELETE /api/collections/:id — delete (items survive; only the grouping goes)
 */
import { deleteCollection, renameCollection } from "@/server/db/queries/library";
import { handle, json, notFound, readJson, requireApiUser } from "@/server/http/respond";
import { requiredString } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const PATCH = handle(async ({ req, params }) => {
  const user = await requireApiUser();
  const body = await readJson(req);
  const name = requiredString(body.name, "name", 120);
  const ok = await renameCollection(user.id, params.id, name);
  if (!ok) throw notFound("No such collection");
  return json({ renamed: true });
});

export const DELETE = handle(async ({ params }) => {
  const user = await requireApiUser();
  const ok = await deleteCollection(user.id, params.id);
  if (!ok) throw notFound("No such collection");
  return json({ deleted: true });
});
