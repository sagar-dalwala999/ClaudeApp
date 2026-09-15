/**
 * Auth helpers for React Server Components. API routes use the wrapper in
 * ../http/respond.ts instead, which answers 401 rather than redirecting.
 */
import { redirect } from "next/navigation";
import { readSessionCookie } from "./cookies";
import { resolveSession, type SessionUser } from "./session";

export async function getAuthUser(): Promise<SessionUser | null> {
  const session = await resolveSession(await readSessionCookie());
  return session?.user ?? null;
}

/** Redirects to /login when there is no valid session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  return user;
}
