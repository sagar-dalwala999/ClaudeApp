/**
 * Browser-safe URL sniffing.
 *
 * The server has the authoritative normaliser (src/server/normalize/url.ts),
 * but it pulls in node:crypto and the platform identity rules. This is only
 * used to decide whether to enable the Save button and to strip a URL out of
 * pasted prose, so a regex is the right tool.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/i;
const BARE_PATTERN = /(?:^|[\s([<])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"'`)\]}]*)?)/i;

function trimTrailing(value: string): string {
  return value.replace(/[.,;:!?'"”’)\]}>]+$/, "");
}

export function extractUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const explicit = text.match(URL_PATTERN);
  if (explicit) return trimTrailing(explicit[0]);
  const bare = text.match(BARE_PATTERN);
  return bare?.[1] ? trimTrailing(bare[1]) : null;
}

export function isProbablyUrl(input: string): boolean {
  const candidate = extractUrl(input);
  if (!candidate) return false;
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return Boolean(url.hostname.includes(".")) && /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}
