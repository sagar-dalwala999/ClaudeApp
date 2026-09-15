/**
 * Normalising what a captured post hands us.
 *
 * The extension reads a post out of the page the person is looking at, so the
 * asset URLs are whatever that page happened to render: a thumbnail-sized
 * `name=small` crop, the same picture twice because the timeline lazy-swapped
 * it, a video with a poster frame but no downloadable source. Everything in
 * here is pure string and array work, deliberately, so the rules are testable
 * without a browser.
 */

/** Pictures kept per item, matching MAX_MEDIA_PER_ITEM in the media pipeline. */
export const MAX_CAPTURE_ASSETS = 4;

export interface RawCaptureAsset {
  kind?: string;
  url?: string;
  base64?: string;
  contentType?: string;
  poster?: string;
  width?: number;
  height?: number;
  alt?: string;
  /** Video length, when the player exposed it. */
  durationMs?: number;
}

export interface CaptureAsset {
  kind: "image" | "video";
  /** Where the bytes live: the mp4 for a video, the picture for an image. */
  remoteUrl: string | null;
  /** A video's poster frame, when the extension could not inline it. */
  posterUrl: string | null;
  /** Bytes the extension fetched with the person's own cookies. */
  inline: { base64: string; contentType: string } | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  durationMs: number | null;
}

export interface CaptureLink {
  url: string;
  /** What the post showed instead of the raw URL, e.g. `apps.apple.com/…`. */
  display: string | null;
  title: string | null;
}

/**
 * X serves every picture through one CDN with the size in the query string,
 * and a timeline renders the small crop. The large variant is the same asset
 * at full resolution, so asking for it costs nothing and archives the real
 * picture rather than a thumbnail.
 */
function upgradeTwitterImage(url: URL): string {
  // Modern form: ?format=jpg&name=small
  if (url.searchParams.has("name")) {
    const name = url.searchParams.get("name");
    if (name && name !== "orig") url.searchParams.set("name", "large");
    return url.toString();
  }
  // Legacy form: /media/ABC.jpg:small
  const legacy = url.pathname.match(/^(.*)(:(?:thumb|small|medium|large|orig))$/);
  if (legacy) {
    url.pathname = `${legacy[1]}:large`;
    return url.toString();
  }
  // Avatars: _normal.jpg is 48px, _400x400.jpg is the stored original.
  if (/_(normal|bigger|mini)\.(jpg|jpeg|png|webp)$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/_(normal|bigger|mini)\./i, "_400x400.");
    return url.toString();
  }
  return url.toString();
}

/**
 * The best variant of a picture we can ask for, or null when the URL is not
 * something we can archive. Signed CDN URLs (Instagram, Reddit previews) are
 * returned untouched: their size lives inside the signature, and editing it
 * turns a working link into a 403.
 */
export function upgradeAssetUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  if (host === "pbs.twimg.com" || host === "abs.twimg.com") return upgradeTwitterImage(url);
  return url.toString();
}

/** Two URLs point at the same picture when only the size differs. */
function assetIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("name");
    parsed.hash = "";
    return `${parsed.hostname}${parsed.pathname.replace(/:(thumb|small|medium|large|orig)$/, "")}${parsed.search}`;
  } catch {
    return url;
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * Turns the raw list into assets worth storing: absolute URLs, best variants,
 * no duplicates, no more than the media pipeline will keep.
 */
export function normalizeCaptureAssets(raw: RawCaptureAsset[] | undefined): { assets: CaptureAsset[]; dropped: number } {
  if (!raw?.length) return { assets: [], dropped: 0 };

  const assets: CaptureAsset[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const entry of raw) {
    const kind: "image" | "video" = entry.kind === "video" ? "video" : "image";
    const remoteUrl = upgradeAssetUrl(entry.url);
    const posterUrl = upgradeAssetUrl(entry.poster);
    const inline =
      entry.base64 && entry.base64.length > 32
        ? {
            base64: entry.base64,
            contentType: entry.contentType?.startsWith("image/") ? entry.contentType : "image/jpeg",
          }
        : null;

    // Nothing to fetch and nothing to store: the row would render as a gap.
    if (!remoteUrl && !posterUrl && !inline) continue;

    // Identity comes from the bytes when we have them, so a video and its own
    // poster frame never collapse into one row.
    const identity = remoteUrl ? assetIdentity(remoteUrl) : posterUrl ? assetIdentity(posterUrl) : `inline:${assets.length}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (assets.length >= MAX_CAPTURE_ASSETS) {
      dropped += 1;
      continue;
    }

    assets.push({
      kind,
      remoteUrl: kind === "video" ? remoteUrl : (remoteUrl ?? posterUrl),
      posterUrl: kind === "video" ? posterUrl : null,
      inline,
      width: positiveInt(entry.width),
      height: positiveInt(entry.height),
      alt: entry.alt?.trim() || null,
      durationMs: positiveInt(entry.durationMs),
    });
  }

  return { assets, dropped };
}

/** Absolute, http(s) links only, deduped, in the order the post showed them. */
export function normalizeCaptureLinks(raw: Array<{ url?: string; display?: string; title?: string }> | undefined): CaptureLink[] {
  if (!raw?.length) return [];
  const links: CaptureLink[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry.url) continue;
    let url: URL;
    try {
      url = new URL(entry.url.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    // A t.co that never got expanded says nothing; the display text is the
    // only part worth keeping, and it is kept below as the display field.
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      url: key,
      display: entry.display?.trim() || null,
      title: entry.title?.trim() || null,
    });
    if (links.length >= 10) break;
  }

  return links;
}

export interface ComposeTextInput {
  text: string | null;
  links: CaptureLink[];
  quoted?: { author?: string | null; authorHandle?: string | null; text?: string | null } | null;
}

/**
 * The text we store for a post.
 *
 * A post that is one line plus a shortener used to archive as one line: the
 * substance sat behind a `t.co` nobody followed. The extension sees the link
 * the way the reader does — expanded, with its destination on screen — so the
 * destination goes into the body, where search and the summariser can see it.
 */
export function composeCaptureText(input: ComposeTextInput): string | null {
  const parts: string[] = [];
  const body = input.text?.trim();
  if (body) parts.push(body);

  const quotedText = input.quoted?.text?.trim();
  if (quotedText) {
    const who = input.quoted?.authorHandle?.trim() || input.quoted?.author?.trim();
    parts.push(who ? `Quoting ${who}: ${quotedText}` : `Quoting: ${quotedText}`);
  }

  // Only worth listing what the body does not already spell out.
  const unseen = input.links.filter((link) => {
    if (!body) return true;
    return !body.includes(link.url) && !(link.display && body.includes(link.display));
  });
  if (unseen.length) {
    const lines = unseen.map((link) => {
      // The display text is where a shortener actually goes, so it is the
      // part that must survive; the title is the extra colour.
      const destination = link.display && link.display !== link.url ? ` → ${link.display}` : "";
      const title = link.title && link.title !== link.display ? ` (${link.title})` : "";
      return `- ${link.url}${destination}${title}`;
    });
    parts.push(`${unseen.length === 1 ? "Link in this post:" : "Links in this post:"}\n${lines.join("\n")}`);
  }

  const joined = parts.join("\n\n").trim();
  return joined || null;
}
