/**
 * GET  /api/tokens — list ingest tokens (never the secret itself)
 * POST /api/tokens — create one; the raw token is returned exactly once
 */
import { createIngestToken, listIngestTokens } from "@/server/auth/session";
import { handle, json, readJson, requireApiUser } from "@/server/http/respond";
import { requiredString } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = await requireApiUser();
  return json({ tokens: await listIngestTokens(user.id) });
});

export const POST = handle(async ({ req }) => {
  const user = await requireApiUser();
  const body = await readJson(req);
  const name = requiredString(body.name, "name", 80);
  const created = await createIngestToken(user.id, name);
  return json(
    {
      token: created.token,
      tokenSummary: created.summary,
      hint: "Copy this now — it is stored hashed and cannot be shown again.",
    },
    { status: 201 },
  );
});
