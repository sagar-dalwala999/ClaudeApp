/**
 * Job worker entry point.
 *
 *   npm run worker
 *
 * A separate process from the web app on purpose: fetching, image encoding and
 * AI calls are slow and memory-hungry, and none of that belongs in a request.
 * Shutdown is graceful so an in-flight job finishes rather than being retried.
 */
import { closeDb, pingDb } from "../db/client";
import { migrate } from "../db/migrate";
import { getEnv } from "../env";
import { handleEnrich } from "./handlers/enrich";
import { handleExportMarkdown } from "./handlers/exportMarkdown";
import { handleMaintenance } from "./handlers/maintenance";
import { handleMedia } from "./handlers/media";
import { handleResolve } from "./handlers/resolve";
import { getBoss, QUEUE, stopBoss, type JobPayloads } from "./queue";
import type { Job } from "pg-boss";

const WORK_OPTIONS = { pollingIntervalSeconds: 2 } as const;

async function main(): Promise<void> {
  if (!(await pingDb())) {
    throw new Error("Cannot reach the database. Check DATABASE_URL and that Postgres is running.");
  }

  // Safe under the migration advisory lock even if the web container is doing
  // the same thing at the same moment.
  const { applied } = await migrate();
  if (applied.length) console.log(`[worker] applied migrations: ${applied.join(", ")}`);

  const boss = await getBoss();

  await boss.work<JobPayloads[typeof QUEUE.resolve]>(QUEUE.resolve, WORK_OPTIONS, async (jobs: Job<JobPayloads[typeof QUEUE.resolve]>[]) => {
    for (const job of jobs) await handleResolve(job.data);
  });
  await boss.work<JobPayloads[typeof QUEUE.media]>(QUEUE.media, WORK_OPTIONS, async (jobs: Job<JobPayloads[typeof QUEUE.media]>[]) => {
    for (const job of jobs) await handleMedia(job.data);
  });
  await boss.work<JobPayloads[typeof QUEUE.enrich]>(QUEUE.enrich, WORK_OPTIONS, async (jobs: Job<JobPayloads[typeof QUEUE.enrich]>[]) => {
    for (const job of jobs) await handleEnrich(job.data);
  });
  await boss.work<JobPayloads[typeof QUEUE.exportMarkdown]>(
    QUEUE.exportMarkdown,
    WORK_OPTIONS,
    async (jobs: Job<JobPayloads[typeof QUEUE.exportMarkdown]>[]) => {
      for (const job of jobs) await handleExportMarkdown(job.data);
    },
  );
  await boss.work<JobPayloads[typeof QUEUE.maintain]>(QUEUE.maintain, WORK_OPTIONS, async () => {
    await handleMaintenance();
  });

  // Every 15 minutes: sessions, telemetry retention, stuck items.
  await boss.schedule(QUEUE.maintain, "*/15 * * * *", {});

  const env = getEnv();
  console.log(
    `[worker] ready — resolvers ${env.ENABLE_LIVE_RESOLVERS ? "on" : "off"}, ` +
      `AI ${env.AI_CHAT_MODEL ? `on (${env.AI_CHAT_MODEL})` : "off"}, storage ${env.STORAGE_DRIVER}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, finishing in-flight jobs…`);
    await stopBoss();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (err) => {
  console.error(`[worker] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  await stopBoss().catch(() => undefined);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
