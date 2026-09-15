/**
 * DELETE /api/tokens/:id — revoke an ingest token immediately.
 */
import { revokeIngestToken } from "@/server/auth/session";
import { handle, json, notFound, requireApiUser } from "@/server/http/respond";

export const dynamic = "force-dynamic";

export const DELETE = handle(async ({ params }) => {
  const user = await requireApiUser();
  const ok = await revokeIngestToken(user.id, params.id);
  if (!ok) throw notFound("No such token");
  return json({ revoked: true });
});
