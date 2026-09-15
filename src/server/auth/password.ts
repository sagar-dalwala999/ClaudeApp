/**
 * Password hashing with scrypt from node:crypto.
 *
 * Chosen over bcrypt/argon2 to keep the image free of native build steps.
 * The encoded form carries its own parameters, so a future change to the
 * work factor lets `needsRehash` upgrade stored hashes on next login.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * OpenSSL allocates `128 * r * (N + p)` bytes for scrypt, and refuses to run
 * when `maxmem` is below that. Budgeting for `N * r` alone is off by one
 * `p`-lane and fails with "memory limit exceeded", so the requirement is
 * computed rather than guessed, with 2x of headroom.
 */
function maxmemFor(N: number, r: number, p: number): number {
  return 256 * r * (N + p);
}

/** OWASP-acceptable interactive-login parameters. */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: maxmemFor(2 ** 15, 8, 1) };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(hashRaw, "base64url");
    salt = Buffer.from(saltRaw, "base64url");
  } catch {
    return false;
  }
  if (!expected.length) return false;

  const derived = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r, p),
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when the stored hash was made with weaker parameters than today's. */
export function needsRehash(encoded: string): boolean {
  const [scheme, nRaw, rRaw, pRaw] = encoded.split("$");
  if (scheme !== "scrypt") return true;
  return Number(nRaw) < PARAMS.N || Number(rRaw) < PARAMS.r || Number(pRaw) < PARAMS.p;
}
