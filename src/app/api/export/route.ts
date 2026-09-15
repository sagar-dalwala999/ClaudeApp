/**
 * GET  /api/export            — every markdown file as JSON
 * GET  /api/export?file=INDEX.md — one file, as a download
 * POST /api/export            — mirror into OBSIDIAN_VAULT_PATH (if configured)
 */
import { buildMarkdownVault } from "@/server/export/markdown";
import { getEnv } from "@/server/env";
import { badRequest, handle, json, notFound, requireApiUser } from "@/server/http/respond";
import { enqueue, QUEUE } from "@/server/jobs/queue";
import { numberField, queryString } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = handle(async ({ url }) => {
  const user = await requireApiUser();
  const limit = numberField(queryString(url, "limit"), 500, 1, 5_000, "limit");
  const files = await buildMarkdownVault({ userId: user.id, limit });

  const file = queryString(url, "file", 60);
  if (file) {
    const content = files[file];
    if (!content) throw notFound("No such file in the export");
    return new Response(content, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${file.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      },
    });
  }

  return json({ files, vaultMirroring: Boolean(getEnv().OBSIDIAN_VAULT_PATH) });
});

export const POST = handle(async () => {
  const user = await requireApiUser();
  if (!getEnv().OBSIDIAN_VAULT_PATH) {
    throw badRequest("OBSIDIAN_VAULT_PATH is not set, so there is no vault to mirror into");
  }
  await enqueue(QUEUE.exportMarkdown, { userId: user.id }, { singletonKey: `export:${Date.now()}` });
  return json({ queued: true });
});
