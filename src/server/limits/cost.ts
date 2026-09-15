/**
 * What the AI calls cost.
 *
 * Enrichment is not capped by anything in here: this module only prices a call
 * so the settings screen can report the day's spend. The table converts token
 * counts into USD micros; update it when a provider's pricing changes, and
 * remember that an unrecognised model is estimated at the fallback price.
 */
import { sql } from "drizzle-orm";
import { rawRows } from "../db/client";

/** USD per 1M tokens. Prefix-matched, longest prefix wins. */
const PRICES: Record<string, { input: number; output: number }> = {
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  default: { input: 0.5, output: 2 },
};

export function priceFor(model: string): { input: number; output: number } {
  // OpenRouter suffixes its free variants with `:free`. They bill nothing, and
  // without this they would be estimated at the fallback price instead.
  if (model.endsWith(":free")) return { input: 0, output: 0 };

  let best: { input: number; output: number } | null = null;
  let bestLength = 0;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (prefix === "default") continue;
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = price;
      bestLength = prefix.length;
    }
  }
  return best ?? PRICES.default;
}

export function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  const micros = (inputTokens * price.input + outputTokens * price.output) / 1_000_000 * 1e6;
  return Math.round(micros);
}

/** Sum of today's enrichment spend, in USD micros. */
export async function spentTodayMicros(): Promise<number> {
  const rows = await rawRows<{ micros: string | null }>(sql`
    SELECT coalesce(sum(cost_micros), 0)::bigint AS micros
    FROM enrichments
    WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'
  `);
  return Number(rows[0]?.micros ?? 0);
}