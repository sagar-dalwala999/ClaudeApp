import { beforeEach, describe, expect, it } from "vitest";
import {
  acquire,
  availableTokens,
  createSemaphore,
  PLATFORM_LIMITS,
  policyFor,
  RateLimitTimeoutError,
  registerAttempt,
  resetAttempts,
  resetRateLimits,
} from "@/server/limits/rateLimit";

describe("policyFor", () => {
  it("resolves a host-scoped key to that platform's published ceiling", () => {
    expect(policyFor("host:reddit")).toBe(PLATFORM_LIMITS.reddit);
    expect(policyFor("host:instagram")).toBe(PLATFORM_LIMITS.instagram);
    expect(policyFor("host:x")).toBe(PLATFORM_LIMITS.x);
  });

  it("falls back to the conservative default for anything unknown", () => {
    expect(policyFor("host:some-blog.example")).toBe(PLATFORM_LIMITS.default);
    expect(policyFor("host:")).toBe(PLATFORM_LIMITS.default);
    expect(policyFor("anything-else")).toBe(PLATFORM_LIMITS.default);
  });

  it("keeps every platform inside its free tier", () => {
    // Reddit allows 100 requests a minute.
    expect(PLATFORM_LIMITS.reddit.refillPerSec * 60).toBeLessThanOrEqual(100);
    // Instagram allows 1,000 oEmbed calls an hour.
    expect(PLATFORM_LIMITS.instagram.refillPerSec * 3600).toBeLessThanOrEqual(1000);
  });
});

describe("acquire", () => {
  beforeEach(() => resetRateLimits());

  it("spends a fresh bucket's burst without waiting", async () => {
    const key = "host:burst-test";
    expect(availableTokens(key)).toBe(PLATFORM_LIMITS.default.capacity);
    for (let i = 0; i < PLATFORM_LIMITS.default.capacity; i++) {
      await acquire(key);
    }
    expect(availableTokens(key)).toBeLessThan(1);
  });

  it("gives up instead of queueing forever when the wait is hopeless", async () => {
    const key = "host:hopeless";
    const policy = { capacity: 1, refillPerSec: 0.001, maxWaitMs: -1 };
    await acquire(key, policy);
    await expect(acquire(key, policy)).rejects.toBeInstanceOf(RateLimitTimeoutError);
  });

  it("serialises concurrent callers on the same key", async () => {
    const key = "host:serial";
    const policy = { capacity: 1, refillPerSec: 1000, maxWaitMs: 5_000 };
    await acquire(key, policy);
    await Promise.all([acquire(key, policy), acquire(key, policy), acquire(key, policy)]);
    // Each of the queued callers consumed a distinct token.
    expect(availableTokens(key)).toBeLessThan(1.5);
  });
});

describe("createSemaphore", () => {
  it("bounds how many downloads or encodes run at once", async () => {
    const semaphore = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all([task(), task(), task(), task(), task(), task()]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(semaphore.active).toBe(0);
  });

  it("releases the slot even when the task throws", async () => {
    const semaphore = createSemaphore(1);
    await expect(semaphore.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(semaphore.active).toBe(0);
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("login throttle", () => {
  beforeEach(() => resetAttempts());

  it("allows the limit and then refuses with the wait it needs", () => {
    const key = "login:someone@example.com";
    registerAttempt(key, 2, 60_000);
    registerAttempt(key, 2, 60_000);
    expect(() => registerAttempt(key, 2, 60_000)).toThrow(/Too many attempts/);
  });

  it("keys the window per identity", () => {
    registerAttempt("login:a", 1, 60_000);
    expect(() => registerAttempt("login:b", 1, 60_000)).not.toThrow();
  });

  it("lets an expired window start over", () => {
    const key = "login:expired";
    registerAttempt(key, 1, -1);
    expect(() => registerAttempt(key, 1, 60_000)).not.toThrow();
  });
});
