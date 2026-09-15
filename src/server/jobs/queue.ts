/**
 * Job queue.
 *
 * pg-boss on the same Postgres instance: durable jobs, retries with backoff,
 * dead-lettering and cron scheduling without running Redis alongside it.
 *
 * Both the web app and the worker can enqueue; only the worker consumes.
 */
import { PgBoss } from "pg-boss";
import { getEnv } from "../env";

export const QUEUE = {
  resolve: "resolve-item",
  media: "fetch-media",
  enrich: "enrich-item",
  exportMarkdown: "export-markdown",
  maintain: "maintain",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface JobPayloads {
  [QUEUE.resolve]: { itemId: string; userId: string; force?: boolean };
  [QUEUE.media]: { itemId: string };
  [QUEUE.enrich]: { itemId: string; force?: boolean };
  [QUEUE.exportMarkdown]: { userId: string };
  [QUEUE.maintain]: { userId?: string };
}

export type JobOf<K extends QueueName> = JobPayloads[K];

const QUEUE_DEFAULTS: Record<QueueName, { retryLimit: number; retryDelay: number; retryBackoff: boolean; expireInSeconds: number }> = {
  [QUEUE.resolve]: { retryLimit: 4, retryDelay: 15, retryBackoff: true, expireInSeconds: 300 },
  [QUEUE.media]: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUE.enrich]: { retryLimit: 4, retryDelay: 45, retryBackoff: true, expireInSeconds: 600 },
  [QUEUE.exportMarkdown]: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
  [QUEUE.maintain]: { retryLimit: 1, retryDelay: 60, retryBackoff: false, expireInSeconds: 300 },
};

let bossPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossPromise) return bossPromise;
  bossPromise = (async () => {
    const boss = new PgBoss({
      connectionString: getEnv().DATABASE_URL,
      max: 6,
      application_name: "looks-queue",
    });
    boss.on("error", (err) => console.error("[queue] error:", err instanceof Error ? err.message : err));
    await boss.start();
    for (const name of Object.values(QUEUE)) {
      // createQueue is idempotent; it updates the policy when it already exists.
      await boss.createQueue(name, QUEUE_DEFAULTS[name]);
    }
    return boss;
  })().catch((err) => {
    // Let the next caller retry rather than caching a failed start.
    bossPromise = null;
    throw err;
  });
  return bossPromise;
}

/**
 * Enqueues a job. `singletonKey` collapses duplicate work: pasting the same
 * link twice while the first attempt is still queued does not fetch twice.
 */
export async function enqueue<K extends QueueName>(
  name: K,
  data: JobOf<K>,
  options: { singletonKey?: string; startAfterSeconds?: number } = {},
): Promise<string | null> {
  const boss = await getBoss();
  const defaults = QUEUE_DEFAULTS[name];
  return boss.send(name, data as object, {
    retryLimit: defaults.retryLimit,
    retryDelay: defaults.retryDelay,
    retryBackoff: defaults.retryBackoff,
    expireInSeconds: defaults.expireInSeconds,
    singletonKey: options.singletonKey,
    startAfter: options.startAfterSeconds,
  });
}

export async function queueHealth(): Promise<Array<{ name: string; queued: number; active: number; failed: number; deferred: number }>> {
  try {
    const boss = await getBoss();
    const out: Array<{ name: string; queued: number; active: number; failed: number; deferred: number }> = [];
    for (const name of Object.values(QUEUE)) {
      const stats = await boss.getQueueStats(name);
      const row = stats[0];
      out.push({
        name,
        queued: Number(row?.queuedCount ?? 0),
        active: Number(row?.activeCount ?? 0),
        failed: Number(row?.failedCount ?? 0),
        deferred: Number(row?.deferredCount ?? 0),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function stopBoss(): Promise<void> {
  const pending = bossPromise;
  bossPromise = null;
  if (!pending) return;
  const boss = await pending.catch(() => null);
  // Graceful: let in-flight handlers finish (up to the timeout) so the job is
  // not merely retried by the next process to come up.
  await boss?.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
}
