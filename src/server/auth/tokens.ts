/**
 * Opaque bearer tokens.
 *
 * Tokens are 256 bits of randomness; only their SHA-256 is stored, so a
 * database leak does not hand over live sessions or ingest tokens.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function tokenMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
