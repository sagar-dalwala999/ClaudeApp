import { getEnv } from "../env";

const API_ENDPOINT = "https://api.scrape.do/";
const PROVIDER_TIMEOUT_MS = 15_000;
const CALLER_TIMEOUT_MS = 18_000;

export interface ScrapeDoPolicy {
  /** Reddit requires residential proxies to avoid its soft-blocked 200 responses. */
  super?: boolean;
}

export interface ScrapeDoResult {
  status: number;
  ok: boolean;
  text: string;
  contentType: string;
  headers: Headers;
}

let nextTokenIndex = 0;

export function scrapeDoTokens(): string[] {
  const seen = new Set<string>();
  return getEnv()
    .SCRAPE_DO_TOKENS.split(",")
    .map((token) => token.trim())
    .filter((token) => {
      if (!token || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

function requestUrl(token: string, targetUrl: string, policy: ScrapeDoPolicy): URL {
  const url = new URL(API_ENDPOINT);
  url.searchParams.set("token", token);
  url.searchParams.set("url", targetUrl);
  url.searchParams.set("output", "raw");
  url.searchParams.set("timeout", String(PROVIDER_TIMEOUT_MS));
  if (policy.super) url.searchParams.set("super", "true");
  return url;
}

async function request(token: string, targetUrl: string, policy: ScrapeDoPolicy): Promise<ScrapeDoResult> {
  let response: Response;
  try {
    response = await fetch(requestUrl(token, targetUrl, policy), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(CALLER_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("Scrape.do request timed out");
    // Undici errors can include the full request URL. Never surface one: it contains the token.
    throw new Error("Scrape.do request failed");
  }

  return {
    status: response.status,
    ok: response.ok,
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
    headers: response.headers,
  };
}

/**
 * Fetch one target through Scrape.do. Logical requests begin on successive
 * tokens. A provider-level 401/429 advances through the rest of the pool;
 * target failures and transient transport failures stay with their first token.
 */
export async function scrapeDoText(targetUrl: string, policy: ScrapeDoPolicy = {}): Promise<ScrapeDoResult> {
  const tokens = scrapeDoTokens();
  if (!tokens.length) throw new Error("Scrape.do is not configured");

  const start = nextTokenIndex % tokens.length;
  nextTokenIndex = (nextTokenIndex + 1) % tokens.length;

  let result: ScrapeDoResult | null = null;
  for (let attempt = 0; attempt < tokens.length; attempt += 1) {
    result = await request(tokens[(start + attempt) % tokens.length], targetUrl, policy);
    if (result.status !== 401 && result.status !== 429) return result;
  }
  return result!;
}
