/**
 * Migration runner.
 *
 * - Files in `drizzle/` run in filename order, each inside its own transaction.
 * - Checksums are recorded, so editing an applied migration is a hard error
 *   instead of a silent divergence.
 * - A Postgres advisory lock serialises runners, which is what makes it safe
 *   for both the web and worker containers to migrate on boot.
 *
 *   npm run db:migrate
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { getEnv } from "../env";

const MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");
/** Arbitrary but stable key for `pg_advisory_lock`. */
const LOCK_KEY = 4820593011;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/** Turn a dead socket into something a person can act on. */
function friendlyConnectError(err: unknown, url: string): Error {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
    const where = (() => {
      try {
        const parsed = new URL(url);
        return `${parsed.hostname}:${parsed.port || 5432}`;
      } catch {
        return "the configured host";
      }
    })();
    return new Error(
      `Could not reach Postgres at ${where}.\n` +
        (code === "ENOTFOUND" ? "That hostname does not resolve — check DATABASE_URL." : "Is it running? `docker compose up -d postgres` starts one with pgvector."),
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function migrate(): Promise<MigrateResult> {
  const env = getEnv();
  const client = new Client({ connectionString: env.DATABASE_URL, application_name: "looks-migrate" });
  try {
    await client.connect();
  } catch (err) {
    throw friendlyConnectError(err, env.DATABASE_URL);
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Blocking lock: if another container is mid-migration we simply wait.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const existing = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>("SELECT filename, checksum FROM schema_migrations")).rows.map(
        (r) => [r.filename, r.checksum],
      ),
    );

    for (const file of files) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = existing.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} changed after it was applied.\n` +
              `Never edit an applied migration — add a new one instead.`,
          );
        }
        skipped.push(file);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
    }

    await bootstrapOwner(client);
  } finally {
    // Released automatically when the session ends, but be explicit.
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }

  return { applied, skipped };
}

/**
 * Creates the owner account from OWNER_EMAIL / OWNER_PASSWORD when the users
 * table is empty, so a fresh deployment has a way in. A no-op afterwards.
 */
async function bootstrapOwner(client: Client): Promise<void> {
  const env = getEnv();
  if (!env.OWNER_EMAIL || !env.OWNER_PASSWORD) return;

  const { rows } = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
  if (rows[0]?.count !== "0") return;

  const { hashPassword } = await import("../auth/password");
  const hash = await hashPassword(env.OWNER_PASSWORD);
  await client.query("INSERT INTO users (email, password_hash) VALUES ($1, $2)", [env.OWNER_EMAIL, hash]);
  console.log(`[migrate] created owner account ${env.OWNER_EMAIL}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  migrate()
    .then(({ applied, skipped }) => {
      if (applied.length) console.log(`[migrate] applied: ${applied.join(", ")}`);
      if (skipped.length) console.log(`[migrate] already applied: ${skipped.length}`);
      if (!applied.length && !skipped.length) console.log("[migrate] no migrations found");
    })
    .catch((err) => {
      console.error(`[migrate] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
