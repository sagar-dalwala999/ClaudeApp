/**
 * Enrichment handler.
 *
 * The AI call is the only step that costs money, so the outcome is logged
 * either way — including the reason nothing was generated, which is what the
 * settings screen and the enrichments table report.
 */
import { enrichItem, forceEnrichItem } from "../../enrich";

export interface EnrichPayload {
  itemId: string;
  force?: boolean;
}

export async function handleEnrich(payload: EnrichPayload): Promise<void> {
  const started = Date.now();
  console.log(`[enrich] ${payload.itemId}: start${payload.force ? " (force)" : ""}`);
  try {
    const outcome = payload.force ? await forceEnrichItem(payload.itemId) : await enrichItem(payload.itemId);
    const latencyMs = Date.now() - started;
    if (outcome.enriched) {
      console.log(`[enrich] ${payload.itemId}: enriched model=${outcome.model ?? "unknown"} tags=${outcome.tags.length} embedding=${outcome.embeddingStored ? "stored" : "skipped"} costMicros=${outcome.costMicros} latencyMs=${latencyMs}`);
      return;
    }
    if (outcome.reason) {
      // Keep the provider's own explanation — "free-models-per-day" is the
      // actionable part, and normalising to the status alone hid it.
      const reason = outcome.reason.startsWith("Network error calling AI provider")
        ? "AI provider network error"
        : outcome.reason.slice(0, 200);
      console.log(`[enrich] ${payload.itemId}: skipped — ${reason} latencyMs=${latencyMs}`);
    }
  } catch (error) {
    const type = error instanceof Error ? error.name : typeof error;
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number" ? ` status=${error.status}` : "";
    console.error(`[enrich] ${payload.itemId}: error type=${type}${status} latencyMs=${Date.now() - started}`);
    throw error;
  }
}
