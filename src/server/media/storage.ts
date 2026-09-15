/**
 * Media storage.
 *
 * Two drivers behind one interface: the local filesystem (default, one Docker
 * volume) and any S3-compatible bucket signed with SigV4. Hotlinking platform
 * CDNs is not an option — Instagram and X image URLs expire and are
 * referrer-checked — so every picture is copied in here.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AwsClient } from "aws4fetch";
import { getEnv } from "../env";

export interface StorageDriver {
  readonly kind: "local" | "s3";
  put(key: string, body: Buffer, contentType: string): Promise<{ key: string; bytes: number }>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

/** Keys are derived from ids, but sanitise anyway: never write outside the root. */
export function safeKey(key: string): string {
  const cleaned = key
    .replace(/\.{2,}/g, ".")
    .replace(/[^a-zA-Z0-9._/-]/g, "")
    .replace(/^\/+/, "");
  if (!cleaned) throw new Error("Empty storage key");
  return cleaned;
}

class LocalStorage implements StorageDriver {
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const full = join(this.root, safeKey(key));
    if (!full.startsWith(this.root + sep)) throw new Error("Storage key escaped the media root");
    return full;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<{ key: string; bytes: number }> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key, bytes: body.byteLength };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    try {
      const path = this.pathFor(key);
      const [body, info] = await Promise.all([readFile(path), stat(path)]);
      if (!info.isFile()) return null;
      return { body, contentType: contentTypeFor(key) };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch {
      /* already gone */
    }
  }
}

class S3Storage implements StorageDriver {
  readonly kind = "s3" as const;
  private readonly client: AwsClient;
  private readonly endpoint: string;

  constructor(endpoint: string, region: string, bucket: string, accessKeyId: string, secretAccessKey: string) {
    this.client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });
    this.endpoint = `${endpoint.replace(/\/+$/, "")}/${bucket}`;
  }

  private url(key: string): string {
    return `${this.endpoint}/${safeKey(key).split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<{ key: string; bytes: number }> {
    const res = await this.client.fetch(this.url(key), {
      method: "PUT",
      headers: { "content-type": contentType, "content-length": String(body.byteLength) },
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed with ${res.status}`);
    return { key, bytes: body.byteLength };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    const res = await this.client.fetch(this.url(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET ${key} failed with ${res.status}`);
    return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? contentTypeFor(key) };
  }

  async delete(key: string): Promise<void> {
    await this.client.fetch(this.url(key), { method: "DELETE" }).catch(() => undefined);
  }
}

function contentTypeFor(key: string): string {
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".avif")) return "image/avif";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".gif")) return "image/gif";
  if (key.endsWith(".mp4")) return "video/mp4";
  return "image/jpeg";
}

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (driver) return driver;
  const env = getEnv();
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error("STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    }
    driver = new S3Storage(env.S3_ENDPOINT, env.S3_REGION, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY);
  } else {
    driver = new LocalStorage(env.MEDIA_DIR);
  }
  return driver;
}

/** Resets the memoised driver. Used by tests. */
export function resetStorage(): void {
  driver = null;
}

/** `items/<itemId>/<mediaId>` — variants append `-card.webp` / `-full.webp`. */
export function mediaKeyPrefix(itemId: string, mediaId: string): string {
  return `items/${itemId}/${mediaId}`;
}

/** Content-addressed key for an inline upload with no media row yet. */
export function inlineKey(userId: string, bytes: Buffer, extension: string): string {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return `uploads/${userId}/${digest}.${extension}`;
}
