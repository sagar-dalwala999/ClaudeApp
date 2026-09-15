/**
 * Pooled Postgres connection.
 *
 * Created on first use, never at import time, so `next build` can evaluate
 * route modules without a database. Cached on globalThis because Next's dev
 * server re-evaluates modules on every hot reload.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { Pool } from "pg";
import { getEnv } from "../env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

const cache = globalThis as unknown as {
  __looksPool?: Pool;
  __looksDb?: Db;
};

export function getPool(): Pool {
  if (cache.__looksPool) return cache.__looksPool;
  const env = getEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "looks",
  });
  // A pool-level error must not take the process down with it.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });
  cache.__looksPool = pool;
  return pool;
}

export function getDb(): Db {
  if (cache.__looksDb) return cache.__looksDb;
  const db = drizzle(getPool(), { schema });
  cache.__looksDb = db;
  return db;
}

/** Run a statement and return its rows, typed by the caller. */
export async function rawRows<T>(query: SQL): Promise<T[]> {
  const result = await getDb().execute(query);
  return (result as unknown as { rows: T[] }).rows ?? [];
}

export async function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => fn(tx as unknown as Db));
}

export async function closeDb(): Promise<void> {
  const pool = cache.__looksPool;
  cache.__looksPool = undefined;
  cache.__looksDb = undefined;
  if (pool) await pool.end();
}

/** Cheap liveness probe used by /api/health. */
export async function pingDb(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
