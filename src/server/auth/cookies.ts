/**
 * Session cookie plumbing. Kept apart from ./session.ts so the session logic
 * stays usable outside a Next request context.
 */
import { cookies } from "next/headers";
import { getEnv } from "../env";

export const SESSION_COOKIE = "looks_session";

function secure(): boolean {
  return getEnv().NODE_ENV === "production";
}

export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function writeSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: secure(),
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set({ name: SESSION_COOKIE, value: "", httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 0 });
}
