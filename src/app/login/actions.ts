"use server";

/**
 * Sign in / sign out.
 *
 * Server actions rather than an API route: the session cookie is set on the
 * response of the same request, there is no token to leak into client JS, and
 * Next gives us CSRF protection for free.
 *
 * The login throttle is per-process (see limits/rateLimit.ts), which is correct
 * for the single web container this app is designed to run as.
 */
import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { clearSessionCookie, readSessionCookie, writeSessionCookie } from "@/server/auth/cookies";
import { hashPassword, needsRehash, verifyPassword } from "@/server/auth/password";
import { createSession, destroySession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { clearAttempts, registerAttempt } from "@/server/limits/rateLimit";

export interface LoginState {
  error: string | null;
}

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 5 * 60 * 1000;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required" };

  try {
    registerAttempt(`login:${email}`, MAX_ATTEMPTS, WINDOW_MS);
  } catch {
    return { error: "Too many attempts. Try again in a few minutes." };
  }

  const db = getDb();
  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  const user = rows[0];

  // Same message and roughly the same work either way: no account oracle.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, await decoyHash());
  if (!user || !ok) return { error: "Those credentials did not work" };

  if (needsRehash(user.passwordHash)) {
    await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, user.id));
  }

  const session = await createSession(user.id, null);
  await writeSessionCookie(session.token, session.expiresAt);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  clearAttempts(`login:${email}`);

  redirect("/");
}

export async function logout(): Promise<void> {
  const token = await readSessionCookie();
  if (token) await destroySession(token).catch(() => undefined);
  await clearSessionCookie();
  redirect("/login");
}

/** Cached so a missing account still costs a scrypt call, without hashing twice. */
let cachedDecoy: string | null = null;
async function decoyHash(): Promise<string> {
  cachedDecoy ??= await hashPassword("decoy-password-for-timing-parity");
  return cachedDecoy;
}
