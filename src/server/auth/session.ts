/**
 * Database-backed sessions.
 *
 * Deliberately framework-free: this module never imports `next/headers`, so
 * scripts and the worker can use it. The cookie plumbing lives in ./cookies.ts.
 */
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { ingestTokens, sessions, users } from "../db/schema";
import { generateToken, hashToken } from "./tokens";

export const SESSION_TTL_DAYS = 30;
/** Refresh `last_seen_at` at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(userId: string, userAgent?: string | null): Promise<CreatedSession> {
  const token = generateToken("sess");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await getDb()
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      userAgent: userAgent?.slice(0, 400) ?? null,
      expiresAt,
    });
  return { token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
}

export async function resolveSession(token: string | null | undefined): Promise<ResolvedSession | null> {
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }

  return {
    sessionId: row.sessionId,
    user: { id: row.userId, email: row.email, displayName: row.displayName },
  };
}

export async function destroySession(token: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function destroyAllSessions(userId: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.userId, userId));
}

export async function pruneExpiredSessions(): Promise<number> {
  const deleted = await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date())).returning({ id: sessions.id });
  return deleted.length;
}

/* --------------------------------------------------------- ingest tokens */

export interface IngestTokenSummary {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function createIngestToken(userId: string, name: string): Promise<{ token: string; summary: IngestTokenSummary }> {
  const token = generateToken("lk");
  const [row] = await getDb()
    .insert(ingestTokens)
    .values({ userId, name: name.slice(0, 80), tokenHash: hashToken(token) })
    .returning();
  return {
    token,
    summary: {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    },
  };
}

export async function listIngestTokens(userId: string): Promise<IngestTokenSummary[]> {
  const rows = await getDb().select().from(ingestTokens).where(eq(ingestTokens.userId, userId));
  return rows
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function revokeIngestToken(userId: string, id: string): Promise<boolean> {
  const updated = await getDb()
    .update(ingestTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(ingestTokens.id, id), eq(ingestTokens.userId, userId), isNull(ingestTokens.revokedAt)))
    .returning({ id: ingestTokens.id });
  return updated.length > 0;
}

/** Verifies an ingest token and returns the owning user, if it is live. */
export async function resolveIngestToken(token: string | null | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({
      tokenId: ingestTokens.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(ingestTokens)
    .innerJoin(users, eq(users.id, ingestTokens.userId))
    .where(and(eq(ingestTokens.tokenHash, hashToken(token)), isNull(ingestTokens.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  await db
    .update(ingestTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(ingestTokens.id, row.tokenId), sql`${ingestTokens.lastUsedAt} IS NULL OR ${ingestTokens.lastUsedAt} < now() - interval '1 hour'`));

  return { id: row.userId, email: row.email, displayName: row.displayName };
}
