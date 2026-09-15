import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The opt-in live suite: `npm run test:live`.
 *
 * These tests fetch other people's servers, so they are excluded from the
 * default run and from CI. They are what you reach for when a platform has
 * changed its rules and you want to know whether it is the resolver or the
 * upstream that broke.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    // Fetches are slow and someone else's fault when they fail.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // One at a time: these share per-host rate limit buckets.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      ENABLE_LIVE_RESOLVERS: "true",
    },
  },
});
