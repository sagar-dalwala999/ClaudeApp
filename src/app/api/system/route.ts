/**
 * GET /api/system — everything the settings screen reports: library counts,
 * resolver health, queue depth, AI spend and the configured adapters.
 */
import { libraryStats, recentResolverEvents, resolverHealth } from "@/server/db/queries/library";
import { getEnv } from "@/server/env";
import { handle, json, requireApiUser } from "@/server/http/respond";
import { queueHealth } from "@/server/jobs/queue";
import { spentTodayMicros } from "@/server/limits/cost";
import { resolverCatalogue } from "@/server/resolve";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await requireApiUser();
  const env = getEnv();

  const [stats, health, events, queues, spentMicros] = await Promise.all([
    libraryStats(user.id),
    resolverHealth(168).catch(() => []),
    recentResolverEvents(40).catch(() => []),
    queueHealth().catch(() => []),
    spentTodayMicros().catch(() => 0),
  ]);

  return json({
    stats,
    resolvers: health,
    events,
    queues,
    catalogue: resolverCatalogue(),
    ai: {
      configured: Boolean(env.AI_CHAT_MODEL),
      model: env.AI_CHAT_MODEL,
      embedModel: env.AI_EMBED_MODEL,
      spentTodayMicros: spentMicros,
    },
    config: {
      storage: env.STORAGE_DRIVER,
      liveResolvers: env.ENABLE_LIVE_RESOLVERS,
      xSyndication: env.ENABLE_X_SYNDICATION,
      reddit: Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET),
      github: Boolean(env.GITHUB_TOKEN),
      obsidianVault: Boolean(env.OBSIDIAN_VAULT_PATH),
    },
  });
});
