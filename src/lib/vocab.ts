/**
 * Shared vocabulary.
 *
 * Pure data with no server imports, so the canvas components, the API layer
 * and the worker all speak the same strings.
 */

export const ITEM_TYPES = ["github", "article", "x-post", "tool", "video", "paper", "other"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["pending", "ready", "unread", "failed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const PLATFORMS = [
  "web",
  "x",
  "reddit",
  "instagram",
  "facebook",
  "threads",
  "github",
  "gitlab",
  "youtube",
  "vimeo",
  "arxiv",
  "hackernews",
  "substack",
  "medium",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const TYPE_LABELS: Record<ItemType, string> = {
  github: "GitHub",
  article: "Article",
  "x-post": "X post",
  tool: "Tool",
  video: "Video",
  paper: "Paper",
  other: "Other",
};

export const STATUS_LABELS: Record<ItemStatus, string> = {
  pending: "Fetching",
  ready: "Ready",
  unread: "Unread",
  failed: "Failed",
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  web: "Web",
  x: "X",
  reddit: "Reddit",
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  github: "GitHub",
  gitlab: "GitLab",
  youtube: "YouTube",
  vimeo: "Vimeo",
  arxiv: "arXiv",
  hackernews: "Hacker News",
  substack: "Substack",
  medium: "Medium",
};

export function isItemType(value: unknown): value is ItemType {
  return typeof value === "string" && (ITEM_TYPES as readonly string[]).includes(value);
}

export function isItemStatus(value: unknown): value is ItemStatus {
  return typeof value === "string" && (ITEM_STATUSES as readonly string[]).includes(value);
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/** Which statuses the UI treats as "still being worked on". */
export function isInFlight(status: ItemStatus): boolean {
  return status === "pending";
}
