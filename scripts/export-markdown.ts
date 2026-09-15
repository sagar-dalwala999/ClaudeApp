/**
 * Write the markdown vault to disk.
 *
 *   npm run export:markdown                 # OBSIDIAN_VAULT_PATH, or ./data/vault
 *   npm run export:markdown -- /path/to/vault
 *
 * Offline equivalent of `POST /api/export`, useful for a cron job or a
 * one-off backup of the archive as plain text.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { buildMarkdownVault } from "../src/server/export/markdown";
import { closeDb, getDb } from "../src/server/db/client";
import { getEnv } from "../src/server/env";
import { users } from "../src/server/db/schema";

async function main(): Promise<void> {
  const target = resolve(process.argv[2] ?? getEnv().OBSIDIAN_VAULT_PATH ?? "./data/vault");
  const email = process.argv.find((arg) => arg.startsWith("--email="))?.slice("--email=".length);

  const db = getDb();
  const rows = email
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
        .limit(1)
    : await db.select({ id: users.id, email: users.email }).from(users).limit(2);

  if (!rows.length) throw new Error("No account exists yet.");
  if (rows.length > 1) throw new Error("More than one account exists. Pass --email=…");

  const files = await buildMarkdownVault({ userId: rows[0].id, limit: 5_000 });
  await mkdir(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (name.includes("/") || name.includes("\\")) continue;
    await writeFile(resolve(target, name), content, "utf8");
  }
  console.log(`[export] wrote ${Object.keys(files).length} files to ${target}`);
}

main()
  .catch((err) => {
    console.error(`[export] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
