/**
 * GET /api/search?q=…
 *
 * Hybrid keyword + semantic search, fused with reciprocal rank fusion. If no
 * embedding provider is configured the keyword half still works, so search
 * degrades rather than breaking.
 */
import { getItems, searchItemIds } from "@/server/db/queries/items";
import { embedText, embeddingsConfigured } from "@/server/enrich/openai";
import { handle, json, requireApiUser } from "@/server/http/respond";
import { numberField, queryString } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = handle(async ({ url }) => {
  const user = await requireApiUser();
  const query = queryString(url, "q", 240);
  const limit = numberField(queryString(url, "limit"), 40, 1, 100, "limit");
  if (!query) return json({ items: [], mode: "empty" });

  let embedding: number[] | null = null;
  let semantic = false;
  if (embeddingsConfigured()) {
    try {
      const { vector } = await embedText(query);
      embedding = vector;
      semantic = Boolean(vector?.length);
    } catch {
      semantic = false;
    }
  }

  const hits = await searchItemIds(user.id, query, embedding, limit);
  const records = await getItems(user.id, hits.map((hit) => hit.id));
  const byId = new Map(records.map((record) => [record.id, record]));

  return json({
    items: hits.map((hit) => byId.get(hit.id)).filter(Boolean),
    mode: semantic ? "hybrid" : "keyword",
    hits: hits.map((hit) => ({ id: hit.id, score: hit.score })),
  });
});
