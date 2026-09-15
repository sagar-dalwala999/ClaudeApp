/**
 * The client-facing item shape.
 *
 * The canvas components were written against a rich display object; this is
 * that object, derived from a database row. Keeping the derived fields here
 * means the drawing code stays free of database concerns.
 */
import type { ItemType, Platform } from "./vocab";

/** Procedural media families drawn by artStyles.ts. */
export type ArtStyle =
  | "photo"
  | "ui"
  | "ascii"
  | "document"
  | "dots"
  | "pixel"
  | "grid"
  | "halftone"
  | "type"
  | "terrain";

export interface ClientMedia {
  id: string;
  kind: string;
  /** Storage key inside our own media storage, once downloaded. */
  storageKey: string | null;
  remoteUrl: string | null;
  width: number | null;
  height: number | null;
  placeholder: string | null;
  alt: string | null;
}

export interface ClientCollection {
  id: string;
  name: string;
  slug: string;
  count: number;
}

/** What the grid, graph and detail view all render. */
export interface ClientItem {
  id: string;
  url: string;
  canonicalUrl: string;
  platform: Platform | string;
  type: ItemType | string;
  title: string;
  /** Alias of the title, kept so the drawing code reads naturally. */
  caption: string;
  summary: string | null;
  note: string | null;
  /**
   * Always populated: the handle when there is one (without the `@`), then the
   * display name, then the site. The canvas components label cards with it.
   */
  author: string;
  /** The raw handle, when the platform gave us one. */
  authorHandle: string | null;
  authorName: string | null;
  siteName: string | null;
  language: string | null;
  publishedAt: string | null;
  addedAt: string;
  updatedAt: string;
  status: string;
  source: string | null;
  lastError: string | null;
  favorite: boolean;
  ai: boolean;
  hasEmbedding: boolean;
  needsCapture: boolean;
  tags: string[];
  collections: Array<{ id: string; name: string }>;
  media: ClientMedia[];
  /** Derived display fields used by the canvas renderers. */
  kind: "image" | "video" | "text";
  /** height / width of the media box. */
  aspect: number;
  /** Deterministic seed for the procedural placeholder. */
  seed: number;
  /** Which procedural family represents this item when it has no picture. */
  style: ArtStyle;
  host: string;
}

/** Minimal shape the server has to hand over. Keeps this module dependency-free. */
export interface ItemLike {
  id: string;
  url: string;
  canonicalUrl?: string;
  platform: string;
  type: string;
  title: string | null;
  summary: string | null;
  note: string | null;
  author: string | null;
  authorHandle: string | null;
  siteName: string | null;
  language: string | null;
  publishedAt: string | null;
  addedAt: string;
  updatedAt: string;
  status: string;
  source: string | null;
  lastError: string | null;
  favorite: boolean;
  ai: boolean;
  hasEmbedding: boolean;
  needsCapture: boolean;
  tags: string[];
  collections: Array<{ id: string; name: string }>;
  media: Array<{
    id: string;
    kind: string;
    storageKey: string | null;
    remoteUrl: string | null;
    width: number | null;
    height: number | null;
    placeholder: string | null;
    alt: string | null;
  }>;
  bodyText?: string | null;
}

/** Deterministic 32-bit hash, so placeholders never shuffle between renders. */
export function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Procedural family used when an item has no archived picture. */
export function styleFor(item: { type: string; platform: string }): ArtStyle {
  switch (item.type) {
    case "github":
      return "grid";
    case "video":
      return "photo";
    case "x-post":
      return "halftone";
    case "paper":
      return "document";
    case "tool":
      return "ui";
    case "article":
      return item.platform === "web" ? "type" : "photo";
    default:
      return item.platform === "instagram" || item.platform === "facebook" ? "photo" : "dots";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A plain-text link has no media; treat a long body with no image as text-only. */
export function kindFor(item: { type: string; media: Array<{ kind: string }>; bodyText?: string | null }): "image" | "video" | "text" {
  if (item.media.some((m) => m.kind === "video")) return "video";
  if (item.media.length > 0) return "image";
  if (item.type === "video") return "video";
  return "text";
}

export function toClientItem(item: ItemLike): ClientItem {
  const first = item.media[0];
  const width = first?.width && first.width > 0 ? first.width : null;
  const height = first?.height && first.height > 0 ? first.height : null;
  const aspect = width && height ? Math.min(Math.max(height / width, 0.5), 1.8) : 0.68;
  const title = item.title?.trim() || hostOf(item.url) || item.url;
  return {
    id: item.id,
    url: item.url,
    canonicalUrl: item.canonicalUrl ?? item.url,
    platform: item.platform,
    type: item.type,
    title,
    caption: title,
    summary: item.summary,
    note: item.note,
    author: displayAuthor(item),
    authorHandle: item.authorHandle,
    authorName: item.author,
    siteName: item.siteName,
    language: item.language,
    publishedAt: item.publishedAt,
    addedAt: item.addedAt,
    updatedAt: item.updatedAt,
    status: item.status,
    source: item.source,
    lastError: item.lastError,
    favorite: item.favorite,
    ai: item.ai,
    hasEmbedding: item.hasEmbedding,
    needsCapture: item.needsCapture,
    tags: item.tags,
    collections: item.collections,
    media: item.media,
    kind: kindFor({ type: item.type, media: item.media, bodyText: item.bodyText }),
    aspect,
    seed: hashSeed(`${item.id}:${item.type}`),
    style: styleFor({ type: item.type, platform: item.platform }),
    host: hostOf(item.url),
  };
}

/** Handle without decoration: `@x` → `x`, `u/name` → `name`, `name` → `name`. */
export function bareHandle(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^@/, "").replace(/^u\//, "");
  return trimmed || null;
}

/** The label cards are stamped with, never empty. */
export function displayAuthor(item: {
  author: string | null;
  authorHandle: string | null;
  siteName: string | null;
  url: string;
}): string {
  return bareHandle(item.authorHandle) ?? item.author ?? item.siteName ?? hostOf(item.url) ?? "unknown";
}

/** `/api/img` URL for a stored variant. */
export function mediaUrl(media: ClientMedia, variant: "card" | "full" = "card"): string | null {
  if (!media.storageKey) return null;
  return `/api/img?key=${encodeURIComponent(media.storageKey)}&v=${variant}`;
}

export function relativeDay(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
