/**
 * Resolver runner.
 *
 * Matching resolvers run in priority order, each with its own timeout, and
 * partial results are merged: the first resolver to supply a field wins, and
 * later ones fill the gaps. We stop early once there is a title plus prose,
 * because this is a personal archive and a saved link beats a perfect one.
 *
 * Every attempt is recorded, so the resolver health panel can show which
 * platform integration is currently broken.
 */
import { getEnv } from "../env";
import type { NormalizedUrl } from "../normalize/url";
import { ALL_RESOLVERS, matchingResolvers } from "./registry";
import type { ResolveOutcome, ResolveRunResult, ResolverContext, ResolverEvent, ResolvedContent } from "./types";

/** Enough to cover the stack for one platform without hammering a host. */
const MAX_RESOLVERS = 6;
const PER_RESOLVER_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, resolverId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${resolverId} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Fills only the fields the accumulating result does not already have. */
function merge(target: ResolvedContent, incoming: ResolvedContent): void {
  const assign = <K extends keyof ResolvedContent>(key: K) => {
    const value = incoming[key];
    if (value === undefined || value === null) return;
    if (typeof value === "string" && !value.trim()) return;
    if (target[key] === undefined || target[key] === null) {
      target[key] = value;
    } else if (typeof target[key] === "string" && typeof value === "string" && !(target[key] as string).trim()) {
      target[key] = value;
    }
  };

  assign("title");
  assign("summary");
  assign("text");
  assign("html");
  assign("author");
  assign("authorHandle");
  assign("siteName");
  assign("language");
  assign("publishedAt");
  assign("url");
  assign("canonical");
  assign("type");
  assign("meta");

  if (incoming.tags?.length) {
    const existing = new Set((target.tags ?? []).map((t) => t.toLowerCase()));
    target.tags = [...(target.tags ?? []), ...incoming.tags.filter((t) => !existing.has(t.toLowerCase()))];
  }
  // Media is not merged: the first resolver that supplies any is the one that
  // understands the platform, and mixing sources produces incoherent cards.
  if ((!target.media || target.media.length === 0) && incoming.media?.length) {
    target.media = incoming.media;
  }
}

/**
 * Do we have enough to write a description from? A long body or a decent
 * summary qualifies outright; a short post qualifies if it came with media
 * (a 60-character tweet with a photo is complete). A bare video title is not,
 * which is what lets the open-graph pass fill in its description.
 */
function hasProse(content: ResolvedContent): boolean {
  const text = content.text?.trim().length ?? 0;
  const summary = content.summary?.trim().length ?? 0;
  const media = content.media?.length ?? 0;
  if (text > 120 || summary > 40) return true;
  return text > 20 && media > 0;
}

export function isComplete(content: ResolvedContent): boolean {
  return Boolean(content.title?.trim() && hasProse(content));
}

/**
 * Platforms that gate their content behind a login. When we end up with a
 * thin result for one of these, the UI offers the browser-extension capture.
 */
const GATED_PLATFORMS = new Set(["instagram", "facebook", "threads", "x"]);

export async function resolveItem(input: NormalizedUrl, ctx: ResolverContext = {}): Promise<ResolveRunResult> {
  const events: ResolverEvent[] = [];
  const content: ResolvedContent = {};
  let source: string | null = null;

  if (!getEnv().ENABLE_LIVE_RESOLVERS) {
    return { content, source: null, events, complete: false, needsCapture: false };
  }

  const candidates = matchingResolvers(input).slice(0, MAX_RESOLVERS);
  const skip = ctx.skip ?? new Set<string>();

  for (const resolver of candidates) {
    // A resolver that has failed repeatedly is stood down until it recovers.
    // Not skipped for the fallback, which cannot fail.
    if (skip.has(resolver.id) && resolver.id !== "url-fallback") {
      events.push({
        resolver: resolver.id,
        outcome: "skipped",
        httpStatus: null,
        latencyMs: 0,
        error: "auto-disabled after repeated failures",
      });
      continue;
    }

    const skipped = resolver.unavailableReason?.() ?? null;
    if (skipped) {
      events.push({ resolver: resolver.id, outcome: "skipped", httpStatus: null, latencyMs: 0, error: skipped });
      continue;
    }

    const started = Date.now();
    let outcome: ResolveOutcome;
    try {
      outcome = await withTimeout(resolver.resolve(input, ctx), PER_RESOLVER_TIMEOUT_MS, resolver.id);
    } catch (err) {
      outcome = { status: "error", reason: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Date.now() - started;

    if (outcome.status === "error") {
      events.push({
        resolver: resolver.id,
        outcome: "error",
        httpStatus: outcome.httpStatus ?? null,
        latencyMs,
        error: outcome.reason.slice(0, 500),
      });
      continue;
    }
    if (outcome.status === "miss") {
      events.push({ resolver: resolver.id, outcome: "miss", httpStatus: null, latencyMs, error: outcome.reason.slice(0, 500) });
      continue;
    }

    merge(content, outcome.content);
    if (!source && outcome.content.title) source = resolver.id;
    events.push({ resolver: resolver.id, outcome: "hit", httpStatus: null, latencyMs, error: null });

    if (isComplete(content)) break;
  }

  const thinText = (content.text?.trim().length ?? 0) < 120 && (content.summary?.trim().length ?? 0) < 40;
  const needsCapture = GATED_PLATFORMS.has(input.platform) && thinText && (content.media?.length ?? 0) === 0;

  return { content, source, events, complete: isComplete(content), needsCapture };
}

/** Resolver metadata for the settings screen. */
export function resolverCatalogue(): Array<{ id: string; priority: number; cost: string; unavailable: string | null }> {
  return ALL_RESOLVERS.map((r) => ({
    id: r.id,
    priority: r.priority,
    cost: r.cost,
    unavailable: r.unavailableReason?.() ?? null,
  }));
}

export type { Resolver, ResolvedContent, ResolvedMedia, ResolveOutcome, ResolverEvent } from "./types";
