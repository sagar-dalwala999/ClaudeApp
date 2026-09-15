/**
 * GitHub and GitLab.
 *
 * The REST API gives everything a link card wants without scraping: name,
 * description, language, topics and stars. Unauthenticated access is 60
 * requests/hour, so a token is optional but strongly advised.
 *
 * The picture comes from GitHub's own OpenGraph image service, which is stable
 * and needs no authentication.
 */
import { getEnv } from "../env";
import { acquire } from "../limits/rateLimit";
import { fetchJson } from "../net/fetch";
import type { NormalizedUrl } from "../normalize/url";
import { truncateText } from "../text/html";
import type { ResolveOutcome, ResolvedMedia, Resolver } from "./types";

export interface GitHubTarget {
  kind: "repo" | "issue" | "pr" | "gist";
  owner: string;
  repo: string;
  number?: string;
  apiUrl: string;
}

/** Resolves a GitHub URL to the API endpoint that describes it. */
export function parseGitHub(url: URL): GitHubTarget | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();

  if (host === "gist.github.com") {
    const id = parts[0] === "gist" ? parts[1] : parts[0];
    if (!id) return null;
    return { kind: "gist", owner: "", repo: "", apiUrl: `https://api.github.com/gists/${id}` };
  }
  const [owner, repo, kind, number] = parts;
  if (!owner || !repo) return null;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  if ((kind === "issues" || kind === "pull") && number && /^\d+$/.test(number)) {
    return { kind: kind === "pull" ? "pr" : "issue", owner, repo, number, apiUrl: `${base}/issues/${number}` };
  }
  return { kind: "repo", owner, repo, apiUrl: base };
}

function headers(): Record<string, string> {
  const token = getEnv().GITHUB_TOKEN;
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  return token ? { ...base, authorization: `Bearer ${token}` } : base;
}

interface RepoResponse {
  full_name?: string;
  name?: string;
  description?: string;
  homepage?: string;
  language?: string;
  topics?: string[];
  stargazers_count?: number;
  forks_count?: number;
  created_at?: string;
  pushed_at?: string;
  archived?: boolean;
  fork?: boolean;
  owner?: { login?: string; type?: string };
  license?: { spdx_id?: string };
}

interface IssueResponse {
  title?: string;
  body?: string;
  state?: string;
  created_at?: string;
  comments?: number;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  pull_request?: unknown;
  repository_url?: string;
}

interface GistResponse {
  description?: string;
  created_at?: string;
  html_url?: string;
  owner?: { login?: string };
  files?: Record<string, { language?: string }>;
}

export const githubResolver: Resolver = {
  id: "github-api",
  priority: 70,
  cost: "free",
  matches: (input) => input.platform === "github",

  unavailableReason: () => (getEnv().ENABLE_LIVE_RESOLVERS ? null : "live resolvers disabled"),

  async resolve(input: NormalizedUrl): Promise<ResolveOutcome> {
    const target = parseGitHub(new URL(input.url));
    if (!target) return { status: "miss", reason: "not a repo, issue or gist URL" };

    await acquire(getEnv().GITHUB_TOKEN ? "github" : "github:anonymous");
    const res = await fetchJson<RepoResponse & IssueResponse & GistResponse>(target.apiUrl, {
      headers: headers(),
      timeoutMs: 12_000,
      maxBytes: 1_500_000,
    });

    if (res.status === 404) return { status: "miss", reason: "repository not found or private" };
    if (res.status === 403 || res.status === 429) {
      return { status: "error", reason: `GitHub API limit reached (${res.status})`, httpStatus: res.status };
    }
    if (!res.ok || !res.data) return { status: "miss", reason: `GitHub responded ${res.status}` };

    const data = res.data;
    const repoLabel = target.kind === "gist" ? (data.html_url ?? input.url) : `${target.owner}/${target.repo}`;
    const media: ResolvedMedia[] = target.kind === "gist"
      ? []
      : [
          {
            kind: "image",
            remoteUrl: `https://opengraph.githubassets.com/1/${target.owner}/${target.repo}`,
            width: 1200,
            height: 600,
            alt: `${repoLabel} on GitHub`,
          },
        ];

    if (target.kind === "repo") {
      const topicTags = (data.topics ?? []).slice(0, 5);
      const material = [
        `${repoLabel}${data.archived ? " (archived)" : ""}`,
        data.description ?? "",
        data.language ? `Language: ${data.language}` : "",
        typeof data.stargazers_count === "number" ? `Stars: ${data.stargazers_count}` : "",
        topicTags.length ? `Topics: ${topicTags.join(", ")}` : "",
        data.homepage ? `Homepage: ${data.homepage}` : "",
        data.license?.spdx_id ? `License: ${data.license.spdx_id}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        status: "hit",
        content: {
          title: repoLabel,
          text: truncateText(material, 8_000),
          author: data.owner?.login ?? target.owner,
          authorHandle: data.owner?.login ? `@${data.owner.login}` : null,
          siteName: "GitHub",
          publishedAt: data.created_at ? new Date(data.created_at) : null,
          type: "github",
          tags: [...topicTags, data.language].filter((t): t is string => Boolean(t)),
          media,
          meta: {
            stars: data.stargazers_count ?? null,
            forks: data.forks_count ?? null,
            language: data.language ?? null,
            archived: data.archived ?? false,
            fork: data.fork ?? false,
          },
        },
      };
    }

    if (target.kind === "gist") {
      const languages = Object.values(data.files ?? {})
        .map((f) => f.language)
        .filter((l): l is string => Boolean(l));
      return {
        status: "hit",
        content: {
          title: data.description || `Gist ${input.url.split("/").pop()}`,
          text: truncateText([data.description ?? "", `Files: ${Object.keys(data.files ?? {}).join(", ")}`].join("\n"), 8_000),
          author: data.owner?.login ?? null,
          authorHandle: data.owner?.login ? `@${data.owner.login}` : null,
          siteName: "GitHub Gist",
          publishedAt: data.created_at ? new Date(data.created_at) : null,
          type: "github",
          tags: [...new Set(languages)].slice(0, 4),
          media,
        },
      };
    }

    const labels = (data.labels ?? []).map((l) => l.name).filter((l): l is string => Boolean(l));
    const isPull = target.kind === "pr" || Boolean(data.pull_request);
    const body = (data.body ?? "").trim();
    const material = [
      `${repoLabel}${target.number ? ` #${target.number}` : ""} — ${isPull ? "pull request" : "issue"} (${data.state ?? "open"})`,
      body,
      labels.length ? `Labels: ${labels.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      status: "hit",
      content: {
        title: data.title?.trim() || `${repoLabel} #${target.number}`,
        text: truncateText(material, 20_000),
        author: data.user?.login ?? null,
        authorHandle: data.user?.login ? `@${data.user.login}` : null,
        siteName: "GitHub",
        publishedAt: data.created_at ? new Date(data.created_at) : null,
        type: "github",
        tags: labels.slice(0, 5),
        media,
        meta: { state: data.state ?? null, comments: data.comments ?? null, kind: target.kind },
      },
    };
  },
};
