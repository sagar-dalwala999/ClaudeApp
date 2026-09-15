/**
 * GET /manifest.webmanifest
 *
 * Served from a route handler rather than `app/manifest.ts` because Next's
 * `MetadataRoute.Manifest` type has no room for `share_target`, and the share
 * target is the whole point: on a phone, the archive is filled by sharing a
 * link into it, not by typing one into a form.
 *
 * Install the app (Add to Home Screen) and every share sheet offers Looks.
 */
import { NextResponse } from "next/server";

const ICON = "/icon.svg";

const manifest = {
  name: "Looks",
  short_name: "Looks",
  description: "A personal link archive: paste a link and it is fetched, summarised and filed.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#0b0b0b",
  theme_color: "#0b0b0b",
  icons: [
    { src: ICON, sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: ICON, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  ],
  share_target: {
    action: "/share",
    method: "POST",
    enctype: "multipart/form-data",
    params: { title: "title", text: "text", url: "url" },
    files: [
      {
        name: "image",
        accept: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      },
    ],
  },
};

export function GET(): NextResponse {
  return NextResponse.json(manifest, {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
