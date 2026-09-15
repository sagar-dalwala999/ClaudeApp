/**
 * Create or reset the owner account.
 *
 *   npm run user:create -- you@example.com
 *   printf '%s' "$PASSWORD" | npm run user:create -- you@example.com
 *   npm run user:create -- you@example.com --reset
 *
 * The password comes from an argument, LOOKS_PASSWORD, or stdin when it is
 * piped. It is never echoed and never stored in plain text.
 */
import { sql } from "drizzle-orm";
import { hashPassword } from "../src/server/auth/password";
import { closeDb, getDb } from "../src/server/db/client";
import { users } from "../src/server/db/schema";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function resolvePassword(): Promise<string> {
  const explicit = process.argv.find((arg) => arg.startsWith("--password="));
  if (explicit) return explicit.slice("--password=".length);
  if (process.env.LOOKS_PASSWORD) return process.env.LOOKS_PASSWORD;
  if (!process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped) return piped;
  }
  throw new Error(
    "No password supplied.\n" +
      "  printf '%s' \"$PASSWORD\" | npm run user:create -- you@example.com\n" +
      "  or set LOOKS_PASSWORD, or pass --password=…",
  );
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  const reset = process.argv.includes("--reset");
  if (!email || email.startsWith("--")) {
    throw new Error("Usage: npm run user:create -- <email> [--password=…] [--reset]");
  }

  const password = await resolvePassword();
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  const db = getDb();
  const hash = await hashPassword(password);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (existing.length) {
    if (!reset) throw new Error(`${email} already exists. Pass --reset to change its password.`);
    await db.update(users).set({ passwordHash: hash }).where(sql`lower(${users.email}) = ${email}`);
    console.log(`[user] password reset for ${email} — existing sessions stay valid`);
    return;
  }

  await db.insert(users).values({ email, passwordHash: hash });
  console.log(`[user] created ${email}`);
}

main()
  .catch((err) => {
    console.error(`[user] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
