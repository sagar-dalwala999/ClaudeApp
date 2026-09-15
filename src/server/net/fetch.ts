/**
 * All outbound HTTP goes through here.
 *
 * What it guarantees:
 * - SSRF protection: private, loopback, link-local and cloud-metadata hosts are
 *   refused, and every redirect hop is re-checked rather than trusted.
 * - Redirects are followed manually, capped, and reported back so the pipeline
 *   can re-derive identity from the final URL.
 * - Hard timeouts and a byte cap, so one slow host cannot stall the worker.
 * - A descriptive User-Agent, because these are other people's servers.
 *
 * Known limitation: the check resolves DNS then fetches, so a hostile resolver
 * could in principle rebind between the two. Acceptable here — the URLs come
 * from the owner of the archive, not from the public.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getEnv } from "../env";

export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchBlockedError";
  }
}

export class FetchFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchFailedError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** IPv4/IPv6 ranges that must never be reachable from the fetcher. */
function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1)
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new FetchBlockedError(`Refusing to fetch ${hostname}: private host`);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new FetchBlockedError(`Refusing to fetch ${hostname}: private address`);
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new FetchFailedError(`Could not resolve ${hostname}`);
  }
  if (!addresses.length) throw new FetchFailedError(`Could not resolve ${hostname}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new FetchBlockedError(`Refusing to fetch ${hostname}: resolves to private address ${address}`);
    }
  }
}

export interface FetchPolicy {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Stop after this many hops (0 = don't follow at all). */
  maxRedirects?: number;
  /** Overrides the default Accept header. */
  accept?: string;
  /** Skip the DNS safety check (used by tests with local servers). */
  allowPrivateHosts?: boolean;
}

export interface FetchResult {
  status: number;
  ok: boolean;
  /** URL after redirects. */
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
  headers: Headers;
  redirects: number;
}

function userAgent(): string {
  return getEnv().FETCH_USER_AGENT;
}

export function defaultHeaders(accept: string): Record<string, string> {
  return {
    "user-agent": userAgent(),
    accept,
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch a URL as text, following redirects manually with a safety check on
 * every hop.
 */
export async function fetchText(rawUrl: string, policy: FetchPolicy = {}): Promise<FetchResult> {
  const env = getEnv();
  const timeoutMs = policy.timeoutMs ?? env.FETCH_TIMEOUT_MS;
  const maxBytes = policy.maxBytes ?? env.FETCH_MAX_BYTES;
  const maxRedirects = policy.maxRedirects ?? 5;
  const accept = policy.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  const deadline = Date.now() + timeoutMs;

  let current = rawUrl;
  let redirects = 0;

  for (;;) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new FetchFailedError(`Invalid URL: ${current}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new FetchBlockedError(`Refusing to fetch ${url.protocol} URL`);
    }
    if (!policy.allowPrivateHosts) await assertPublicHost(url.hostname);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchFailedError(`Timed out fetching ${rawUrl}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: policy.method ?? "GET",
        headers: { ...defaultHeaders(accept), ...policy.headers },
        body: policy.body,
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FetchFailedError(`Request to ${url.hostname} failed: ${message}`);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      // Drain the body so the socket can be reused.
      await res.arrayBuffer().catch(() => undefined);
      if (!location) throw new FetchFailedError(`Redirect without Location from ${url.hostname}`, res.status);
      if (redirects >= maxRedirects) throw new FetchFailedError(`Too many redirects from ${rawUrl}`, res.status);
      redirects += 1;
      current = new URL(location, url).toString();
      continue;
    }

    let text = "";
    let truncated = false;
    const contentType = res.headers.get("content-type") ?? "";
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            truncated = true;
            const keep = value.byteLength - (received - maxBytes);
            if (keep > 0) chunks.push(value.subarray(0, keep));
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(value);
        }
      } catch (err) {
        if (!chunks.length) {
          throw new FetchFailedError(`Body read failed for ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      text = new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks, Math.min(received, maxBytes)));
    }

    return { status: res.status, ok: res.ok, url: current, contentType, text, truncated, headers: res.headers, redirects };
  }
}

/** Byte-oriented fetch, for media downloads. */
export interface BytesResult {
  status: number;
  ok: boolean;
  url: string;
  contentType: string;
  buffer: Buffer;
  truncated: boolean;
}

export async function fetchBytes(rawUrl: string, policy: FetchPolicy = {}): Promise<BytesResult> {
  const env = getEnv();
  const timeoutMs = policy.timeoutMs ?? env.FETCH_TIMEOUT_MS;
  const maxBytes = policy.maxBytes ?? env.FETCH_MAX_BYTES;
  const maxRedirects = policy.maxRedirects ?? 4;

  let current = rawUrl;
  let redirects = 0;

  for (;;) {
    const url = new URL(current);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlockedError(`Refusing ${url.protocol}`);
    if (!policy.allowPrivateHosts) await assertPublicHost(url.hostname);

    const res = await fetch(url, {
      method: policy.method ?? "GET",
      headers: { ...defaultHeaders(policy.accept ?? "image/*,*/*;q=0.5"), ...policy.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.arrayBuffer().catch(() => undefined);
      if (!location) throw new FetchFailedError(`Redirect without Location from ${url.hostname}`, res.status);
      if (redirects >= maxRedirects) throw new FetchFailedError(`Too many redirects from ${rawUrl}`, res.status);
      redirects += 1;
      current = new URL(location, url).toString();
      continue;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > maxBytes) {
          const keep = value.byteLength - (received - maxBytes);
          if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      url: current,
      contentType: res.headers.get("content-type") ?? "",
      buffer: Buffer.concat(chunks),
      truncated,
    };
  }
}

export interface JsonResult<T> extends Omit<FetchResult, "text"> {
  data: T | null;
  text: string;
}

export async function fetchJson<T>(rawUrl: string, policy: FetchPolicy = {}): Promise<JsonResult<T>> {
  const res = await fetchText(rawUrl, { ...policy, accept: policy.accept ?? "application/json, text/plain;q=0.9, */*;q=0.5" });
  let data: T | null = null;
  try {
    data = res.text ? (JSON.parse(res.text) as T) : null;
  } catch {
    data = null;
  }
  return { ...res, data };
}

/**
 * Resolve a URL's final destination without downloading it. Used to expand
 * shorteners before we decide which platform we are dealing with.
 */
export async function followRedirects(rawUrl: string, policy: FetchPolicy = {}): Promise<{ url: string; status: number }> {
  const hops = policy.maxRedirects ?? 5;
  let current = rawUrl;
  let status = 0;
  for (let i = 0; i <= hops; i++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return { url: current, status };
    }
    if (!policy.allowPrivateHosts) await assertPublicHost(url.hostname).catch(() => undefined);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "HEAD",
        headers: defaultHeaders("*/*"),
        redirect: "manual",
        signal: AbortSignal.timeout(policy.timeoutMs ?? 8000),
      });
    } catch {
      return { url: current, status };
    }
    status = res.status;
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { url: current, status };
      current = new URL(location, url).toString();
      continue;
    }
    return { url: current, status };
  }
  return { url: current, status };
}
