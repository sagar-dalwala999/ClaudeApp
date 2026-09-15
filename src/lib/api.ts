/**
 * Browser-side API client.
 *
 * One place that knows the routes and the error shape, so components deal in
 * results and thrown Errors rather than status codes.
 */
import type { ClientCollection, ItemLike } from "./item";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const error = body as { error?: string; code?: string } | null;
    throw new ApiError(error?.error ?? `Request failed (${res.status})`, res.status, error?.code);
  }
  return body as T;
}

export interface ItemListResponse {
  items: ItemLike[];
  nextCursor: string | null;
}

export interface CreateItemResponse {
  item: ItemLike;
  created: boolean;
  duplicate: boolean;
}

export interface TagSummary {
  name: string;
  label: string;
  count: number;
  hasEmbedding: boolean;
}

export interface ResolverHealthRow {
  resolver: string;
  attempts: number;
  hits: number;
  misses: number;
  errors: number;
  skipped: number;
  successRate: number;
  p50LatencyMs: number;
  lastError: string | null;
  lastSeenAt: string | null;
  consecutiveFailures: number;
  disabled: boolean;
}

export interface SystemResponse {
  stats: {
    items: number;
    ready: number;
    pending: number;
    failed: number;
    unread: number;
    enriched: number;
    mediaCount: number;
    mediaBytes: number;
    tags: number;
    collections: number;
    addedToday: number;
    addedThisWeek: number;
  };
  resolvers: ResolverHealthRow[];
  events: Array<{ id: string; resolver: string; outcome: string; error: string | null; createdAt: string; itemId: string | null }>;
  queues: Array<{ name: string; queued: number; active: number; failed: number; deferred: number }>;
  catalogue: Array<{ id: string; priority: number; cost: string; unavailable: string | null }>;
  ai: { configured: boolean; model: string; embedModel: string; spentTodayMicros: number };
  config: {
    storage: string;
    liveResolvers: boolean;
    xSyndication: boolean;
    reddit: boolean;
    github: boolean;
    obsidianVault: boolean;
  };
}

export interface IngestTokenSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const api = {
  listItems(params: {
    collectionId?: string | null;
    tag?: string | null;
    type?: string | null;
    status?: string | null;
    favorite?: boolean;
    sort?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<ItemListResponse> {
    const search = new URLSearchParams();
    if (params.collectionId) search.set("collectionId", params.collectionId);
    if (params.tag) search.set("tag", params.tag);
    if (params.type) search.set("type", params.type);
    if (params.status) search.set("status", params.status);
    if (params.favorite) search.set("favorite", "1");
    if (params.sort) search.set("sort", params.sort);
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    return request<ItemListResponse>(`/api/items?${search.toString()}`);
  },

  createItem(url: string, collectionId?: string | null): Promise<CreateItemResponse> {
    return request<CreateItemResponse>("/api/items", {
      method: "POST",
      body: JSON.stringify({ url, collectionId: collectionId ?? null }),
    });
  },

  getItem(id: string): Promise<{ item: ItemLike }> {
    return request<{ item: ItemLike }>(`/api/items/${id}`);
  },

  patchItem(id: string, patch: Record<string, unknown>): Promise<{ item: ItemLike }> {
    return request<{ item: ItemLike }>(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  },

  deleteItem(id: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(`/api/items/${id}`, { method: "DELETE" });
  },

  retryItem(id: string, force = false): Promise<{ queued: boolean }> {
    return request<{ queued: boolean }>(`/api/items/${id}/retry`, { method: "POST", body: JSON.stringify({ force }) });
  },

  search(query: string, limit = 40): Promise<{ items: ItemLike[]; mode: string }> {
    return request<{ items: ItemLike[]; mode: string }>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  },

  listCollections(): Promise<{ collections: ClientCollection[]; previews: Record<string, ItemLike[]>; recent: ItemLike[] }> {
    return request<{ collections: ClientCollection[]; previews: Record<string, ItemLike[]>; recent: ItemLike[] }>("/api/collections");
  },

  createCollection(name: string): Promise<{ collection: ClientCollection }> {
    return request<{ collection: ClientCollection }>("/api/collections", { method: "POST", body: JSON.stringify({ name }) });
  },

  deleteCollection(id: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(`/api/collections/${id}`, { method: "DELETE" });
  },

  listTags(limit = 400): Promise<{ tags: TagSummary[] }> {
    return request<{ tags: TagSummary[] }>(`/api/tags?limit=${limit}`);
  },

  setTags(itemId: string, tags: string[]): Promise<{ tags: string[] }> {
    return request<{ tags: string[] }>("/api/tags", { method: "POST", body: JSON.stringify({ itemId, tags }) });
  },

  listTokens(): Promise<{ tokens: IngestTokenSummary[] }> {
    return request<{ tokens: IngestTokenSummary[] }>("/api/tokens");
  },

  createToken(name: string): Promise<{ token: string; tokenSummary: IngestTokenSummary }> {
    return request<{ token: string; tokenSummary: IngestTokenSummary }>("/api/tokens", { method: "POST", body: JSON.stringify({ name }) });
  },

  revokeToken(id: string): Promise<{ revoked: boolean }> {
    return request<{ revoked: boolean }>(`/api/tokens/${id}`, { method: "DELETE" });
  },

  system(): Promise<SystemResponse> {
    return request<SystemResponse>("/api/system");
  },

  exportFiles(limit = 500): Promise<{ files: Record<string, string>; vaultMirroring: boolean }> {
    return request<{ files: Record<string, string>; vaultMirroring: boolean }>(`/api/export?limit=${limit}`);
  },

  mirrorExport(): Promise<{ queued: boolean }> {
    return request<{ queued: boolean }>("/api/export", { method: "POST" });
  },
};
