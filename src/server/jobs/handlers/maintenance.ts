/**
 * Periodic maintenance.
 *
 * Three jobs, run every fifteen minutes:
 *   1. drop expired sessions
 *   2. trim resolver telemetry older than the retention window
 *   3. re-queue items stuck in `pending` — the self-healing path for a worker
 *      that died mid-flight, or a resolver that has since started working again
 */
import { sql } from "drizzle-orm";
import { rawRows } from "../../db/client";
import { stalePendingItems } from "../../db/queries/items";
import { pruneExpiredSessions } from "../../auth/session";
import { enqueue, QUEUE } from "../queue";

const EVENT_RETENTION_DAYS = 30;
/** Bounded so a long-neglected instance cannot delete a million rows at once. */
const EVENT_PRUNE_BATCH = 5_000;

async function pruneResolverEvents(): Promise<number> {
  const rows = await rawRows<{ id: string }>(sql`
    DELETE FROM resolver_events
    WHERE id IN (
      SELECT id FROM resolver_events
      WHERE created_at < now() - make_interval(days => ${EVENT_RETENTION_DAYS})
      LIMIT ${EVENT_PRUNE_BATCH}
    )
    RETURNING id
  `);
  return rows.length;
}

export async function handleMaintenance(): Promise<void> {
  const sessions = await pruneExpiredSessions().catch((err) => {
    console.warn(`[maintain] session prune failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  });

  const events = await pruneResolverEvents().catch(() => 0);

  let requeued = 0;
  const stale = await stalePendingItems(25).catch(() => []);
  for (const item of stale) {
    await enqueue(QUEUE.resolve, { itemId: item.id, userId: item.userId }, { singletonKey: item.id }).catch(() => undefined);
    requeued += 1;
  }

  if (sessions || events || requeued) {
    console.log(`[maintain] sessions removed: ${sessions}, events trimmed: ${events}, items requeued: ${requeued}`);
  }
}
