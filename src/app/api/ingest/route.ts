/**
 * POST /api/ingest — the capture endpoint for things that are not the app.
 *
 * Callers, one contract:
 *   - the browser extension (`extension/`), which reads the page you are
 *     already signed into and can include the visible image
 *   - an iOS Shortcut or an Android share sheet, which posts form data
 *   - `curl`, for scripting
 *
 * Auth is an ingest token (`Authorization: Bearer …`, `x-looks-token`, or
 * `?token=`), or the session cookie when the app itself calls it.
 */
import { badRequest, extensionCors, handle, requireIngestUser } from "@/server/http/respond";
import { ingestCapture } from "@/server/ingest";
import { InvalidUrlError } from "@/server/normalize/url";
import { parseCapture, parseMultipartCapture, type CapturePayload } from "@/server/resolve/extension";

export const dynamic = "force-dynamic";

/** Multipart (share sheet, Shortcut) and JSON (extension, curl) both land here. */
async function readPayload(req: Request): Promise<{ payload: CapturePayload; source: "extension" | "share" }> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest("Could not read the form body");
    }
    return { payload: await parseMultipartCapture(form), source: "share" };
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest("Body must be JSON or multipart/form-data");
  }
  return { payload: parseCapture(body), source: "extension" };
}

export const OPTIONS = handle(async ({ req }) => new Response(null, { status: 204, headers: extensionCors(req) }));

export const POST = handle(async ({ req, url }) => {
  const user = await requireIngestUser(req, url);
  const { payload, source } = await readPayload(req);

  const { item, created, captured, storedAssets } = await ingestCapture({ userId: user.id, payload, source }).catch((err) => {
    if (err instanceof InvalidUrlError) throw badRequest(err.message);
    throw err;
  });

  return new Response(JSON.stringify({ item, created, captured, storedAssets }), {
    status: created ? 201 : 200,
    headers: { "content-type": "application/json", ...extensionCors(req) },
  });
});
