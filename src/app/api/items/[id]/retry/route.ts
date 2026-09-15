/**
 * POST /api/items/:id/retry
 *
 * Re-runs the pipeline for one item. `force: true` ignores the
 * unchanged-content guard, which is what "re-enrich" in the UI sends.
 */
import { getItem } from "@/server/db/queries/items";
import { handle, json, notFound, readJson, requireApiUser } from "@/server/http/respond";
import { enqueue, QUEUE } from "@/server/jobs/queue";

export const dynamic = "force-dynamic";

export const POST = handle(async ({ req, params }) => {
  const user = await requireApiUser();
  const item = await getItem(user.id, params.id);
  if (!item) throw notFound("No such item");

  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const force = body.force === true;

  await enqueue(QUEUE.resolve, { itemId: item.id, userId: user.id, force }, { singletonKey: `${item.id}:${Date.now()}` });
  return json({ queued: true, force });
});
