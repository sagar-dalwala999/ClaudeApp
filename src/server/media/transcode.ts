/**
 * Image transcoding.
 *
 * Two WebP variants per picture (a grid-sized card and a larger full view) plus
 * a dominant-colour placeholder so the canvas can paint something immediately.
 * Pages hand us 12 MB PNGs, AVIF with odd colour profiles, animated GIFs and
 * the occasional SVG; everything is normalised here.
 *
 * sharp is loaded dynamically: if the native binary is unavailable in some
 * deployment, the pipeline stores the original bytes instead of failing.
 */

export const VARIANTS = [
  { label: "card", width: 640 },
  { label: "full", width: 1280 },
] as const;

export type VariantLabel = (typeof VARIANTS)[number]["label"];

export interface EncodedVariant {
  label: VariantLabel;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
  buffer: Buffer;
}

export interface EncodedImage {
  variants: EncodedVariant[];
  width: number;
  height: number;
  placeholder: string | null;
  animated: boolean;
  sourceFormat: string;
}

const ALLOWED_FORMATS = new Set(["jpeg", "jpg", "png", "webp", "gif", "avif", "tiff", "heif", "svg"]);
/** 50 megapixels: generous for photos, a hard stop for decompression bombs. */
const MAX_INPUT_PIXELS = 50_000_000;

type SharpInstance = ReturnType<typeof import("sharp").default>;
type SharpFactory = (input?: string | Buffer, options?: Record<string, unknown>) => SharpInstance;

let sharpUnavailable = false;

async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpUnavailable) return null;
  try {
    const mod: unknown = await import("sharp");
    const candidate = (mod as { default?: unknown }).default ?? mod;
    if (typeof candidate !== "function") {
      sharpUnavailable = true;
      return null;
    }
    return candidate as SharpFactory;
  } catch {
    sharpUnavailable = true;
    return null;
  }
}

export function sharpIsAvailable(): boolean {
  return !sharpUnavailable;
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

async function dominantColour(sharp: SharpFactory, input: Buffer): Promise<string | null> {
  try {
    const { data } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" })
      .resize(1, 1, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (data.length < 3) return null;
    return toHex(data[0], data[1], data[2]);
  } catch {
    return null;
  }
}

export async function encodeImage(input: Buffer): Promise<EncodedImage | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;

  let format: string;
  let width = 0;
  let height = 0;
  let pages = 1;
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" }).metadata();
    format = (meta.format ?? "").toLowerCase();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    pages = meta.pages ?? 1;
  } catch {
    return null;
  }
  if (!format || !ALLOWED_FORMATS.has(format) || width === 0 || height === 0) return null;

  const variants: EncodedVariant[] = [];
  for (const variant of VARIANTS) {
    try {
      const result = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none", animated: false })
        .rotate()
        .resize({ width: variant.width, withoutEnlargement: true, fit: "inside" })
        .webp({ quality: 78, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      variants.push({
        label: variant.label,
        width: result.info.width,
        height: result.info.height,
        bytes: result.data.byteLength,
        contentType: "image/webp",
        buffer: result.data,
      });
    } catch {
      /* try the next size */
    }
  }
  if (!variants.length) return null;

  const largest = variants.reduce((best, v) => (v.width * v.height > best.width * best.height ? v : best), variants[0]);

  return {
    variants,
    width: largest.width,
    height: largest.height,
    placeholder: await dominantColour(sharp, input),
    animated: pages > 1,
    sourceFormat: format,
  };
}

/** Sniffs a format from magic bytes, for inline uploads with no filename. */
export function sniffImageFormat(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  if (buffer.subarray(4, 12).toString("ascii").includes("ftyp")) return "avif";
  return null;
}
