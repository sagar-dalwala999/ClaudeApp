/**
 * Small coercion helpers for request bodies.
 *
 * Everything that arrives from a client is untrusted: these make the
 * difference between a 400 with a useful message and a stringified object in
 * a text column.
 */
import { badRequest } from "./respond";

export function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`"${field}" is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`"${field}" must be at most ${max} characters`);
  return trimmed;
}

/** Returns null for an explicit null, undefined when the field was absent. */
export function optionalString(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest(`"${field}" must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`"${field}" must be at most ${max} characters`);
  return trimmed || null;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw badRequest(`"${field}" must be a boolean`);
}

export function enumField<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`"${field}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function numberField(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`"${field}" must be a number`);
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function stringArrayField(value: unknown, field: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest(`"${field}" must be an array`);
  if (value.length > maxItems) throw badRequest(`"${field}" must have at most ${maxItems} items`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw badRequest(`"${field}" must contain strings`);
    return entry.slice(0, maxLength);
  });
}

/** Query-string readers, which always arrive as strings or null. */
export function queryString(url: URL, key: string, max = 400): string | null {
  const value = url.searchParams.get(key);
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}
