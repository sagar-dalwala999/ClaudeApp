/**
 * Politeness limits for outbound traffic.
 *
 * In-memory on purpose: the job worker is a single process, so a per-process
 * bucket is the correct scope. (Login throttling in the web app uses the same
 * code and is documented as per-process.)
 *
 * Platform budgets are the published free-tier ceilings, trimmed a little:
 *   Reddit     100 QPM per OAuth client
 *   Instagram  1,000 oEmbed requests per hour, tokenless
 *   X oEmbed   documented as unlimited; we still stay near 1 rps
 */
import { HttpError } from "../http/respond";

export class RateLimitTimeoutError extends Error {
  constructor(key: string) {
    super(`Gave up waiting for rate limit on ${key}`);
    this.name = "RateLimitTimeoutError";
  }
}

export interface RateLimitPolicy {
  /** Burst size. */
  capacity: number;
  /** Sustained rate, tokens per second. */
  refillPerSec: number;
  /** Give up (rather than queue forever) after this long. */
  maxWaitMs?: number;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
  chain: Promise<unknown>;
  policy: RateLimitPolicy;
}

const buckets = new Map<string, BucketState>();

export const PLATFORM_LIMITS: Record<string, RateLimitPolicy> = {
  reddit: { capacity: 60, refillPerSec: 100 / 60, maxWaitMs: 60_000 },
  instagram: { capacity: 40, refillPerSec: 900 / 3600, maxWaitMs: 120_000 },
  facebook: { capacity: 40, refillPerSec: 900 / 3600, maxWaitMs: 120_000 },
  threads: { capacity: 40, refillPerSec: 900 / 3600, maxWaitMs: 120_000 },
  x: { capacity: 20, refillPerSec: 1, maxWaitMs: 60_000 },
  github: { capacity: 30, refillPerSec: 0.5, maxWaitMs: 120_000 },
  youtube: { capacity: 20, refillPerSec: 1, maxWaitMs: 60_000 },
  /** Anything else: two requests a second per host, small burst. */
  default: { capacity: 4, refillPerSec: 1, maxWaitMs: 60_000 },
};

export function policyFor(key: string): RateLimitPolicy {
  const [scope, host] = key.split(":");
  if (scope === "host" && host) return PLATFORM_LIMITS[host] ?? PLATFORM_LIMITS.default;
  return PLATFORM_LIMITS[key] ?? PLATFORM_LIMITS.default;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until one token is available, then consumes it. */
export async function acquire(key: string, policy = policyFor(key)): Promise<void> {
  const state: BucketState =
    buckets.get(key) ?? { tokens: policy.capacity, updatedAt: Date.now(), chain: Promise.resolve(), policy };
  state.policy = policy;
  buckets.set(key, state);

  // Serialise per key: concurrent callers queue rather than all waking up at once.
  const run = state.chain.then(async () => {
    const deadline = Date.now() + (policy.maxWaitMs ?? 60_000);
    for (;;) {
      const now = Date.now();
      const elapsed = (now - state.updatedAt) / 1000;
      if (elapsed > 0) {
        state.tokens = Math.min(policy.capacity, state.tokens + elapsed * policy.refillPerSec);
        state.updatedAt = now;
      }
      if (state.tokens >= 1) {
        state.tokens -= 1;
        return;
      }
      if (now > deadline) throw new RateLimitTimeoutError(key);
      const waitMs = Math.ceil(((1 - state.tokens) / policy.refillPerSec) * 1000);
      await sleep(Math.max(50, Math.min(waitMs, 5_000)));
    }
  });
  state.chain = run.catch(() => undefined);
  return run;
}

/** Non-blocking probe, used by tests and the health panel. */
export function availableTokens(key: string): number {
  const state = buckets.get(key);
  if (!state) return policyFor(key).capacity;
  const elapsed = (Date.now() - state.updatedAt) / 1000;
  return Math.min(state.policy.capacity, state.tokens + elapsed * state.policy.refillPerSec);
}

export function resetRateLimits(): void {
  buckets.clear();
}

/* ------------------------------------------------------------ concurrency */

export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
}

/** Bounded parallelism for downloads and image encoding. */
export function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    get active() {
      return active;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        waiters.shift()?.();
      }
    },
  };
}

/* --------------------------------------------------------- login throttle */

interface AttemptWindow {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, AttemptWindow>();

/** Sliding-window counter used to blunt login brute force. */
export function registerAttempt(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const window = attempts.get(key);
  if (!window || window.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  window.count += 1;
  if (window.count > limit) {
    const seconds = Math.ceil((window.resetAt - now) / 1000);
    throw new HttpError(429, `Too many attempts. Try again in ${seconds}s.`, "rate_limited");
  }
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}

export function resetAttempts(): void {
  attempts.clear();
}
