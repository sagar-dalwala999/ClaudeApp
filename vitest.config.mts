import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Unit tests never touch the network or a database; the adapters are
    // exercised by the opt-in suite in tests/live (`npm run test:live`).
    env: {
      NODE_ENV: "test",
      ENABLE_LIVE_RESOLVERS: "false",
    },
  },
});
