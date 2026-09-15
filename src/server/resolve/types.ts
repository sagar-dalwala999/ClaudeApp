/**
 * The resolver contract.
 *
 * One interface per way of getting data, so a platform changing its rules is
 * a one-file change. Resolvers are pure of database access: they return
 * content plus an outcome, and the runner records the telemetry.
 */
import type { ItemType } from "../../lib/vocab";
import type { NormalizedUrl } from "../normalize/url";

export interface ResolvedMedia {
  kind: "image" | "video";
  /** Where the bytes live now; the media job copies them into storage. */
  remoteUrl: string;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  /** Higher-resolution variant of the same picture, if the platform offers one. */
  fallbackUrl?: string | null;
}

export interface ResolvedContent {
  title?: string | null;
  summary?: string | null;
  /** Extracted prose. Truncated by the caller before storage. */
  text?: string | null;
  html?: string | null;
  author?: string | null;
  authorHandle?: string | null;
  siteName?: string | null;
  language?: string | null;
  publishedAt?: Date | null;
  type?: ItemType;
  tags?: string[];
  media?: ResolvedMedia[];
  /** Raw metadata, stored for reprocessing. Size-capped by the runner. */
  meta?: Record<string, unknown> | null;
  /** Final URL, when the resolver followed redirects or found a canonical. */
  url?: string;
  canonical?: string | null;
  /** Set when the platform returned something worth showing but we could not read it. */
  partial?: boolean;
}

export interface ResolverContext {
  itemId?: string | null;
  /** Resolvers the health telemetry has auto-disabled. */
  skip?: Set<string>;
}

export type ResolveOutcome =
  | { status: "hit"; content: ResolvedContent }
  | { status: "miss"; reason: string }
  | { status: "error"; reason: string; httpStatus?: number | null };

export interface Resolver {
  id: string;
  /** Ascending: lower numbers run first, and win field conflicts. */
  priority: number;
  cost: "free" | "paid";
  matches(input: NormalizedUrl): boolean;
  resolve(input: NormalizedUrl, ctx: ResolverContext): Promise<ResolveOutcome>;
  /** Non-null when this resolver cannot run at all (missing config, disabled). */
  unavailableReason?(): string | null;
}

export type ResolverEventOutcome = "hit" | "miss" | "error" | "skipped";

export interface ResolverEvent {
  resolver: string;
  outcome: ResolverEventOutcome;
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
}

export interface ResolveRunResult {
  content: ResolvedContent;
  /** The resolver that supplied the title — what we show as the source. */
  source: string | null;
  events: ResolverEvent[];
  /** True once we have a title and some prose to summarise. */
  complete: boolean;
  /** True when the platform gates its content and the extension should help. */
  needsCapture: boolean;
}

/** Pulls an HTTP status out of an error message, for telemetry only. */
export function statusFromReason(reason: string): number | null {
  const match = reason.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : null;
}
