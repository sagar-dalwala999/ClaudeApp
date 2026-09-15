/**
 * Tag reconciliation.
 *
 * The model proposes tags freely; this module makes them land on the existing
 * vocabulary. Without it, a year of saving produces `ai`, `AI`, `ai-tools`,
 * `ai_tools` and `artificial-intelligence` as five different tags and search
 * quietly stops working.
 *
 * Three passes, cheapest first:
 *   1. exact match against existing tags
 *   2. stem match, which folds plurals ("tools" → "tool")
 *   3. embedding similarity above a threshold, which folds synonyms
 *      ("cli-tools" → "command-line")
 * Anything that matches is recorded in tag_aliases, so the same decision is
 * instant next time and never needs the model again.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { setItemTags } from "../db/queries/items";
import { tagAliases, tags } from "../db/schema";
import { normalizeTags, tagStem } from "../text/tags";
import { embedTexts, embeddingsConfigured } from "./openai";

/** Cosine above which two tags are treated as the same idea. */
const SIMILARITY_THRESHOLD = 0.86;

export interface TagAssignment {
  names: string[];
  aliases: Array<{ candidate: string; matched: string }>;
  embedded: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function loadVocabulary(userId: string): Promise<{
  byName: Map<string, { id: string; embedding: number[] | null }>;
  aliases: Map<string, { tagId: string; name: string }>;
}> {
  const db = getDb();
  const tagRows = await db
    .select({ id: tags.id, name: tags.name, embedding: tags.embedding })
    .from(tags)
    .where(eq(tags.userId, userId));

  const byName = new Map<string, { id: string; embedding: number[] | null }>();
  for (const row of tagRows) {
    byName.set(row.name, { id: row.id, embedding: row.embedding && row.embedding.length ? row.embedding : null });
  }

  const aliasRows = await db
    .select({ alias: tagAliases.alias, tagId: tagAliases.tagId, name: tags.name })
    .from(tagAliases)
    .innerJoin(tags, eq(tags.id, tagAliases.tagId))
    .where(eq(tagAliases.userId, userId));

  return { byName, aliases: new Map(aliasRows.map((row) => [row.alias, { tagId: row.tagId, name: row.name }])) };
}

export async function assignTags(
  userId: string,
  itemId: string,
  candidates: string[],
  source: "ai" | "user" = "ai",
): Promise<TagAssignment> {
  const normalized = normalizeTags(candidates);
  if (!normalized.length) {
    await setItemTags(userId, itemId, [], source);
    return { names: [], aliases: [], embedded: 0 };
  }

  const { byName, aliases } = await loadVocabulary(userId);
  const byStem = new Map<string, string>();
  for (const name of byName.keys()) {
    const stem = tagStem(name);
    if (!byStem.has(stem)) byStem.set(stem, name);
  }

  const resolved: Array<{ candidate: string; name: string; matchedExisting: boolean }> = [];
  const unresolved: string[] = [];

  for (const candidate of normalized) {
    if (byName.has(candidate)) {
      resolved.push({ candidate, name: candidate, matchedExisting: true });
      continue;
    }
    const alias = aliases.get(candidate);
    if (alias) {
      resolved.push({ candidate, name: alias.name, matchedExisting: true });
      continue;
    }
    const stemMatch = byStem.get(tagStem(candidate));
    if (stemMatch && stemMatch !== candidate) {
      resolved.push({ candidate, name: stemMatch, matchedExisting: true });
      continue;
    }
    unresolved.push(candidate);
  }

  // Semantic fold for anything still unmatched, when we have vectors to compare.
  const withEmbeddings = [...byName.entries()].filter(([, value]) => value.embedding !== null);
  if (unresolved.length && withEmbeddings.length && embeddingsConfigured()) {
    try {
      const { vectors } = await embedTexts(unresolved.map((tag) => tag.replace(/-/g, " ")));
      for (let i = 0; i < unresolved.length; i++) {
        const vector = vectors[i];
        if (!vector?.length) {
          resolved.push({ candidate: unresolved[i], name: unresolved[i], matchedExisting: false });
          continue;
        }
        let best: { name: string; score: number } | null = null;
        for (const [name, value] of withEmbeddings) {
          if (!value.embedding) continue;
          const score = cosineSimilarity(vector, value.embedding);
          if (!best || score > best.score) best = { name, score };
        }
        if (best && best.score >= SIMILARITY_THRESHOLD) {
          resolved.push({ candidate: unresolved[i], name: best.name, matchedExisting: true });
        } else {
          resolved.push({ candidate: unresolved[i], name: unresolved[i], matchedExisting: false });
        }
      }
    } catch {
      // Embedding unavailable: fall back to keeping the raw candidates.
      for (const candidate of unresolved) resolved.push({ candidate, name: candidate, matchedExisting: false });
    }
  } else {
    for (const candidate of unresolved) resolved.push({ candidate, name: candidate, matchedExisting: false });
  }

  const uniqueNames = [...new Set(resolved.map((r) => r.name))];
  const names = await setItemTags(userId, itemId, uniqueNames, source);

  // Give brand-new tags a vector so the next save can fold onto them.
  let embedded = 0;
  const fresh = await getDb()
    .select({ id: tags.id, name: tags.name, embedding: tags.embedding })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.name, names)))
    .then((rows) => rows.filter((row) => !row.embedding || row.embedding.length === 0));

  if (fresh.length && embeddingsConfigured()) {
    try {
      const { vectors } = await embedTexts(fresh.map((row) => row.name.replace(/-/g, " ")));
      for (let i = 0; i < fresh.length; i++) {
        const vector = vectors[i];
        if (!vector?.length) continue;
        await getDb()
          .update(tags)
          .set({ embedding: vector })
          .where(eq(tags.id, fresh[i].id));
        embedded += 1;
      }
    } catch {
      /* embeddings are an optimisation, not a requirement */
    }
  }

  // Remember the folds so they never need a model call again.
  const aliasRecords: Array<{ candidate: string; matched: string }> = [];
  for (const entry of resolved) {
    if (!entry.matchedExisting || entry.candidate === entry.name) continue;
    const target = byName.get(entry.name);
    if (!target) continue;
    aliasRecords.push({ candidate: entry.candidate, matched: entry.name });
    await getDb()
      .insert(tagAliases)
      .values({ userId, tagId: target.id, alias: entry.candidate })
      .onConflictDoNothing({ target: [tagAliases.userId, tagAliases.alias] });
  }

  return { names, aliases: aliasRecords, embedded };
}
