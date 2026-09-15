/**
 * GET /api/health — liveness for Docker and uptime checks. No auth, no data.
 */
import { pingDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { handle, json } from "@/server/http/respond";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const database = await pingDb();
  const env = getEnv();
  return json(
    {
      ok: database,
      database: database ? "up" : "down",
      ai: env.AI_CHAT_MODEL ? "configured" : "disabled",
      liveResolvers: env.ENABLE_LIVE_RESOLVERS,
      storage: env.STORAGE_DRIVER,
      time: new Date().toISOString(),
    },
    { status: database ? 200 : 503 },
  );
});
