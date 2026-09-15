/**
 * robots.txt compliance for the generic web fetcher.
 *
 * Platform API and oEmbed endpoints are not crawled pages, so they bypass this;
 * article and blog pages do not.
 *
 * One caveat is deliberate: if robots.txt cannot be fetched (network error,
 * 5xx) we allow the request. A repository that refuses to record a link
 * because someone else's robots.txt was down is worse than the alternative, and
 * we are fetching a single page the owner asked for, not crawling.
 */
import { fetchText } from "../net/fetch";

interface Rule {
  allow: boolean;
  pattern: string;
}

interface RobotsFile {
  rules: Rule[];
  crawlDelaySec?: number;
  fetchedAt: number;
  status: "ok" | "missing" | "unavailable";
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 200_000;
const cache = new Map<string, RobotsFile>();

function botName(): string {
  return "looksbot";
}

function parseRobots(text: string): RobotsFile {
  const rules: Rule[] = [];
  let crawlDelaySec: number | undefined;
  let applies = false;
  let inGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      const agent = value.toLowerCase();
      // A new group starts; we care about `*` and our own name.
      if (!inGroup) {
        applies = agent === "*" || agent.includes(botName());
        inGroup = true;
      } else {
        applies = applies || agent === "*" || agent.includes(botName());
      }
      continue;
    }
    if (field === "disallow" || field === "allow") {
      inGroup = true;
      if (!applies) continue;
      rules.push({ allow: field === "allow", pattern: value });
      continue;
    }
    if (field === "crawl-delay") {
      if (!applies) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) crawlDelaySec = Math.min(parsed, 30);
    }
  }

  return { rules, crawlDelaySec, fetchedAt: Date.now(), status: "ok" };
}

async function load(origin: string): Promise<RobotsFile> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  let file: RobotsFile;
  try {
    const res = await fetchText(`${origin}/robots.txt`, {
      accept: "text/plain",
      maxBytes: MAX_BYTES,
      timeoutMs: 6000,
      maxRedirects: 3,
    });
    if (res.status === 404) file = { rules: [], fetchedAt: Date.now(), status: "missing" };
    else if (!res.ok) file = { rules: [], fetchedAt: Date.now(), status: "unavailable" };
    else file = parseRobots(res.text);
  } catch {
    file = { rules: [], fetchedAt: Date.now(), status: "unavailable" };
  }
  cache.set(origin, file);
  return file;
}

/** Longest-match wins, per the de-facto standard. */
function isAllowedBy(file: RobotsFile, path: string): boolean {
  let best: Rule | null = null;
  for (const rule of file.rules) {
    if (rule.pattern === "" ) {
      // "Disallow:" with an empty value means allow everything.
      if (!rule.allow && best === null) best = { allow: true, pattern: "" };
      continue;
    }
    if (!path.startsWith(rule.pattern)) continue;
    if (!best || rule.pattern.length > best.pattern.length) best = rule;
  }
  return best ? best.allow : true;
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelaySec?: number;
  status: RobotsFile["status"];
}

export async function robotsDecision(rawUrl: string): Promise<RobotsDecision> {
  const url = new URL(rawUrl);
  const file = await load(url.origin);
  return {
    allowed: isAllowedBy(file, url.pathname + url.search),
    crawlDelaySec: file.crawlDelaySec,
    status: file.status,
  };
}

export function resetRobotsCache(): void {
  cache.clear();
}
