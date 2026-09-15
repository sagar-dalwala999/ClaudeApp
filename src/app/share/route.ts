/**
 * POST /share — the share target.
 *
 * When the archive is installed on a phone, sharing a link from any app lands
 * here. It is the same capture path as `/api/ingest`, authenticated by the
 * session cookie the browser already sends, but it answers with a redirect
 * back to the wall instead of JSON, because the caller is a browser, not a
 * script.
 *
 * The new card is the newest item in the archive, so the redirect lands on a
 * wall that already shows it (pending, then filled in by the worker).
 */
import { readSessionCookie } from "@/server/auth/cookies";
import { resolveSession } from "@/server/auth/session";
import { HttpError, handle } from "@/server/http/respond";
import { ingestCapture, InvalidUrlError } from "@/server/ingest";
import { parseMultipartCapture } from "@/server/resolve/extension";

export const dynamic = "force-dynamic";

/** A dead end on a phone should still read like something a person wrote. */
function problem(status: number, title: string, detail: string): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{background:#0b0b0b;color:#e8e6e3;font:16px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:3rem 1.5rem}
main{max-width:32rem;margin:0 auto}h1{font-size:1.25rem;font-weight:600;margin:0 0 .75rem}
p{color:#a9a49d;margin:0 0 1.5rem}a{color:#e8e6e3}</style></head>
<body><main><h1>${title}</h1><p>${detail}</p><a href="/">Back to the archive</a></main></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export const POST = handle(async ({ req, url }) => {
  const session = await resolveSession(await readSessionCookie());
  if (!session) {
    // Signing in lands on the wall, where the card will be once it is saved.
    return Response.redirect(new URL("/login", url), 303);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return problem(400, "Could not read the share", "The browser sent a body we could not parse.");
  }

  try {
    const payload = await parseMultipartCapture(form);
    await ingestCapture({ userId: session.user.id, payload, source: "share" });
  } catch (err) {
    if (err instanceof InvalidUrlError) {
      return problem(400, "That share had no link in it", "Looks needs a URL — share the page, not an image from it.");
    }
    if (err instanceof HttpError) {
      return problem(err.status, "That capture was rejected", err.message);
    }
    console.error("[share] failed:", err);
    return problem(500, "Could not save that link", "Something went wrong on the server. It is in the logs.");
  }

  return Response.redirect(new URL("/", url), 303);
});
