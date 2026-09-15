/**
 * Platform detection and stable identity keys.
 *
 * The identity key is what makes dedupe work: the same tweet pasted as
 * `twitter.com/user/status/123`, `x.com/user/status/123?s=20` and
 * `https://x.com/i/web/status/123` all resolve to `x:123`.
 *
 * Pure module — no network, no database, no `node:` imports — so it is cheap
 * to unit test and safe to import anywhere.
 */
import type { ItemType, Platform } from "../../lib/vocab";

/** Hosts we treat as aliases of a canonical host. */
const HOST_ALIASES: Record<string, string> = {
  "www.twitter.com": "x.com",
  "mobile.twitter.com": "x.com",
  "twitter.com": "x.com",
  "m.twitter.com": "x.com",
  "www.x.com": "x.com",
  "www.reddit.com": "reddit.com",
  "old.reddit.com": "reddit.com",
  "np.reddit.com": "reddit.com",
  "new.reddit.com": "reddit.com",
  "m.reddit.com": "reddit.com",
  "www.instagram.com": "instagram.com",
  "m.instagram.com": "instagram.com",
  "www.threads.net": "threads.net",
  "www.threads.com": "threads.com",
  "threads.com": "threads.net",
  "www.facebook.com": "facebook.com",
  "m.facebook.com": "facebook.com",
  "web.facebook.com": "facebook.com",
  "www.youtube.com": "youtube.com",
  "m.youtube.com": "youtube.com",
  "www.vimeo.com": "vimeo.com",
  "www.arxiv.org": "arxiv.org",
  "www.news.ycombinator.com": "news.ycombinator.com",
  "www.substack.com": "substack.com",
  "www.medium.com": "medium.com",
};

export function canonicalHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, "");
  const aliased = HOST_ALIASES[lower];
  if (aliased) return aliased;
  // `www.` is decoration everywhere else, so fold it away too.
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

const PLATFORM_HOSTS: Array<[Platform, (host: string) => boolean]> = [
  ["x", (h) => h === "x.com" || h === "t.co"],
  ["reddit", (h) => h === "reddit.com" || h.endsWith(".redd.it") || h === "redd.it" || h === "redditmedia.com" || h.endsWith(".reddit.com")],
  ["instagram", (h) => h === "instagram.com" || h.endsWith(".instagram.com") || h === "instagr.am"],
  ["threads", (h) => h === "threads.net" || h.endsWith(".threads.net") || h === "threads.com"],
  ["facebook", (h) => h === "facebook.com" || h.endsWith(".facebook.com") || h === "fb.watch" || h === "fb.com"],
  ["github", (h) => h === "github.com" || h === "gist.github.com" || h.endsWith(".github.com")],
  ["gitlab", (h) => h === "gitlab.com" || h.endsWith(".gitlab.com")],
  ["youtube", (h) => h === "youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com"],
  ["vimeo", (h) => h === "vimeo.com" || h.endsWith(".vimeo.com")],
  ["arxiv", (h) => h === "arxiv.org" || h.endsWith(".arxiv.org")],
  ["hackernews", (h) => h === "news.ycombinator.com"],
  ["medium", (h) => h === "medium.com" || h.endsWith(".medium.com")],
  ["substack", (h) => h === "substack.com" || h.endsWith(".substack.com")],
];

export function detectPlatform(host: string): Platform {
  const h = canonicalHost(host);
  for (const [platform, matches] of PLATFORM_HOSTS) {
    if (matches(h)) return platform;
  }
  return "web";
}

/** What the platform implies about the kind of thing this is, before AI sees it. */
export function typeHintFor(platform: Platform, url: URL): ItemType {
  switch (platform) {
    case "github":
      return "github";
    case "arxiv":
      return "paper";
    case "youtube":
    case "vimeo":
      return "video";
    case "x":
    case "threads":
      return "x-post";
    case "reddit":
    case "hackernews":
      return "article";
    case "instagram":
    case "facebook":
      return "other";
    default:
      // A root path is usually a product; a deep path is usually writing.
      return url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).length <= 1 ? "tool" : "article";
  }
}

/** Optional path segments that carry no identity of their own. */
const NOISE_SEGMENTS = new Set(["-", "s", "i", "web", "statuses", "comments", "post", "posts", "p", "reel", "reels", "tv", "shorts", "abs", "pdf", "item", "issues", "pull", "discussions", "wiki", "blob", "tree", "releases", "tag", "watch", "embed"]);

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

/**
 * A stable, platform-aware identity string. Falls back to a hash of the
 * canonical URL for anything we don't understand.
 */
export function platformIdentity(url: URL, platform: Platform, hash: (url: URL) => string): string {
  const parts = segments(url);
  const query = url.searchParams;

  switch (platform) {
    case "x": {
      const id =
        parts.find((p, i) => (parts[i - 1] === "status" || parts[i - 1] === "statuses") && /^\d+$/.test(p)) ??
        (/^\d+$/.test(parts[1] ?? "") ? parts[1] : undefined);
      if (id && /^\d+$/.test(id)) return `x:${id}`;
      const handle = parts[0];
      return handle ? `x:@${handle.toLowerCase()}` : `url:${hash(url)}`;
    }
    case "reddit": {
      const idx = parts.indexOf("comments");
      const id = idx !== -1 ? parts[idx + 1] : undefined;
      if (id) return `reddit:${id}`;
      // short links (redd.it/abc123) carry the post id as the only segment
      const host = url.hostname.toLowerCase();
      if (host === "redd.it" || host === "www.redd.it") return `reddit:${parts[0]}`;
      if (parts.length === 1 && /^[a-z0-9]{5,8}$/i.test(parts[0])) return `reddit:${parts[0]}`;
      const sub = query.get("subreddit");
      return sub ? `reddit:r/${sub.toLowerCase()}` : `url:${hash(url)}`;
    }
    case "instagram": {
      const idx = parts.findIndex((p) => ["p", "reel", "reels", "tv"].includes(p));
      const code = idx !== -1 ? parts[idx + 1] : undefined;
      return code ? `instagram:${code}` : `url:${hash(url)}`;
    }
    case "threads": {
      const idx = parts.indexOf("post");
      const code = idx !== -1 ? parts[idx + 1] : undefined;
      return code ? `threads:${code}` : `url:${hash(url)}`;
    }
    case "facebook": {
      const story = query.get("story_fbid") ?? query.get("fbid") ?? query.get("v");
      if (story) return `facebook:${story}`;
      const idx = parts.findIndex((p) => ["posts", "videos", "reel", "watch"].includes(p));
      const id = idx !== -1 ? parts[idx + 1] : undefined;
      return id ? `facebook:${id}` : `url:${hash(url)}`;
    }
    case "github":
    case "gitlab": {
      const host = url.hostname.toLowerCase();
      if (host === "gist.github.com") {
        // gist.github.com/<user>/<id> or gist.github.com/<id>
        const gist = parts.length >= 2 ? parts[1] : parts[0];
        return gist ? `gist:${gist}` : `url:${hash(url)}`;
      }
      const [owner, repo, kind, ref] = parts;
      if (!owner || !repo) return `url:${hash(url)}`;
      const base = `${platform === "github" ? "gh" : "gl"}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
      // Issues and PRs are their own items; branches inside a repo are not.
      if ((kind === "issues" || kind === "pull" || kind === "discussions") && ref && /^\d+$/.test(ref)) {
        return `${base}#${kind === "pull" ? "pr" : kind}/${ref}`;
      }
      if (kind === "releases" && ref) return `${base}#release/${ref}`;
      return base;
    }
    case "youtube": {
      const v = query.get("v");
      if (v) return `youtube:${v}`;
      if (url.hostname.toLowerCase() === "youtu.be" && parts[0]) return `youtube:${parts[0]}`;
      const idx = parts.findIndex((p) => p === "shorts" || p === "live" || p === "embed");
      const id = idx !== -1 ? parts[idx + 1] : undefined;
      if (id) return `youtube:${id}`;
      return parts[0]?.startsWith("@") ? `youtube:${parts[0].toLowerCase()}` : `url:${hash(url)}`;
    }
    case "vimeo": {
      const id = parts.find((p) => /^\d+$/.test(p));
      return id ? `vimeo:${id}` : `url:${hash(url)}`;
    }
    case "arxiv": {
      const idx = parts.findIndex((p) => p === "abs" || p === "pdf");
      const id = (idx !== -1 ? parts[idx + 1] : parts[0])?.replace(/v\d+$/, "");
      return id ? `arxiv:${id}` : `url:${hash(url)}`;
    }
    case "hackernews": {
      const id = query.get("id");
      return id ? `hn:${id}` : `url:${hash(url)}`;
    }
    default:
      return `url:${hash(url)}`;
  }
}

/** True for path segments that are pure noise in display contexts. */
export function isNoiseSegment(segment: string): boolean {
  return NOISE_SEGMENTS.has(segment);
}
