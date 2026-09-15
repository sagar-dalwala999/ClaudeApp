/**
 * Mint an ingest token from the command line.
 *
 *   npm run tokens:create -- "Arc extension"
 *   npm run tokens:create -- "Shortcut" --email you@example.com
 *
 * Prints the raw token once; it is stored hashed.
 */
import { sql } from "drizzle-orm";
import { createIngestToken } from "../src/server/auth/session";
import { closeDb, getDb } from "../src/server/db/client";
import { users } from "../src/server/db/schema";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((arg) => !arg.startsWith("--"));
  const emailFlag = args.find((arg) => arg.startsWith("--email="));
  if (!name) throw new Error('Usage: npm run tokens:create -- "<name>" [--email=you@example.com]');

  const db = getDb();
  const target = emailFlag
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(sql`lower(${users.email}) = ${emailFlag.slice("--email=".length).toLowerCase()}`)
        .limit(1)
    : await db.select({ id: users.id, email: users.email }).from(users).limit(2);

  if (!target.length) throw new Error("No account exists yet. Run `npm run user:create` first.");
  if (target.length > 1) throw new Error("More than one account exists. Pass --email=… to choose one.");

  const created = await createIngestToken(target[0].id, name);
  console.log(`[token] for ${target[0].email}: ${created.token}`);
  console.log("[token] store it now — it cannot be shown again. Revoke it from /settings.");
}

main()
  .catch((err) => {
    console.error(`[token] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
