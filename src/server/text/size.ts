/**
 * Size caps for anything we persist.
 *
 * An archive accumulates whatever the web hands it, so every field that comes
 * from a page gets a ceiling before it reaches Postgres.
 */

export const BODY_TEXT_LIMIT = 20_000;
export const HTML_LIMIT = 200_000;
export const META_JSON_LIMIT = 20_000;
export const TITLE_LIMIT = 500;
export const SUMMARY_LIMIT = 5_000;

export function clampText(value: string | null | undefined, limit: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  return trimmed;
}

/**
 * Serialises a value for a jsonb column, degrading to a marker string rather
 * than blowing up the row when a page hands us something enormous.
 */
export function capJsonForStorage(value: unknown, limit = META_JSON_LIMIT): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { note: "unserialisable metadata" };
  }
  if (!json || json === "null") return null;
  if (json.length <= limit) {
    return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  }
  const wrapper = { truncated: true, preview: json.slice(0, Math.max(0, limit - 40)), bytes: json.length };
  return wrapper;
}
