/**
 * Environment configuration.
 *
 * Parsed lazily and memoised: `next build` evaluates module scope without a
 * database or API keys present, so nothing here may run at import time.
 * Every module that needs config calls `getEnv()` inside a function.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/** `true`/`1`/`yes`/`on` — anything else (or blank) falls back to the default. */
const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : /^(1|true|yes|on)$/i.test(v.trim())));

/** Optional integer with a default; blank strings count as unset. */
const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : Number(v.trim())))
    .pipe(z.number().int().finite());

const optionalText = z
  .string()
  .optional()
  .transform((v) => v?.trim() ?? "");

const envSchema = z.object({
  NODE_ENV: z.string().optional().transform((v) => v ?? "development"),
  LOG_LEVEL: z.string().optional().transform((v) => v ?? "info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  OWNER_EMAIL: optionalText,
  OWNER_PASSWORD: optionalText,

  AI_API_KEY: optionalText,
  /** Sent as `user-agent` on provider calls. Some gateways fingerprint the client and refuse everything else. */
  AI_USER_AGENT: optionalText,
  AI_BASE_URL: z.string().optional().transform((v) => (v?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")),
  AI_CHAT_MODEL: optionalText,
  AI_EMBED_MODEL: optionalText,
  AI_JSON_MODE: z.enum(["auto", "json-schema", "json-object", "prompt"]).optional().transform((v) => v ?? "auto"),
  AI_MAX_TOKENS_PARAM: z.enum(["max_tokens", "max_completion_tokens"]).optional().transform((v) => v ?? "max_tokens"),
  /** Ceiling on one completion. Unset means the request carries no limit. */
  AI_MAX_OUTPUT_TOKENS: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? Number(v.trim()) : null))
    .pipe(z.number().int().positive().nullable()),

  STORAGE_DRIVER: z.enum(["local", "s3"]).optional().transform((v) => v ?? "local"),
  MEDIA_DIR: z.string().optional().transform((v) => v?.trim() || "./data/media"),
  S3_ENDPOINT: optionalText,
  S3_REGION: z.string().optional().transform((v) => v?.trim() || "auto"),
  S3_BUCKET: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,

  ENABLE_X_SYNDICATION: flag(true),
  ENABLE_LIVE_RESOLVERS: flag(true),
  SCRAPE_DO_TOKENS: optionalText,
  REDDIT_CLIENT_ID: optionalText,
  REDDIT_CLIENT_SECRET: optionalText,
  REDDIT_USERNAME: optionalText,
  REDDIT_PASSWORD: optionalText,
  GITHUB_TOKEN: optionalText,

  FETCH_USER_AGENT: z.string().optional().transform((v) => v?.trim() || "LooksBot/0.2 (+https://github.com/your-org/looks)"),
  FETCH_TIMEOUT_MS: int(15000),
  FETCH_MAX_BYTES: int(5_000_000),

  OBSIDIAN_VAULT_PATH: optionalText,
  EXTENSION_ORIGINS: optionalText,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;
let loadedDotEnv = false;

/**
 * Minimal .env reader for entrypoints Next doesn't wrap (worker, scripts,
 * tests). Next itself already loads these files; this only fills gaps.
 */
function loadDotEnvOnce() {
  if (loadedDotEnv) return;
  loadedDotEnv = true;
  // Next loads these files itself for every route, so only the standalone
  // entrypoints (worker, scripts) need this. Keeping it out of the bundled
  // runtime also keeps the build from tracing the whole project.
  if (process.env.NEXT_RUNTIME) return;
  if (process.env.DATABASE_URL && process.env.AUTH_SECRET) return;
  for (const file of [".env.local", ".env"]) {
    try {
      const text = readFileSync(resolve(/* turbopackIgnore: true */ process.cwd(), file), "utf8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (!key || process.env[key] !== undefined) continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    } catch {
      /* file is optional */
    }
  }
}

export function getEnv(): Env {
  if (cached) return cached;
  loadDotEnvOnce();
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const source = {
    // Placeholders let unit tests import modules that read config without
    // needing a real database. Nothing connects in tests.
    DATABASE_URL: process.env.DATABASE_URL ?? (isTest ? "postgres://test:test@127.0.0.1:5432/test" : undefined),
    AUTH_SECRET: process.env.AUTH_SECRET ?? (isTest ? "test-secret-test-secret-test-secret" : undefined),
    ...process.env,
  };
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }
  cached = parsed.data;
  return cached;
}

/** Origin allowlist for browser-extension captures. */
export function extensionOrigins(): string[] {
  return getEnv()
    .EXTENSION_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}
