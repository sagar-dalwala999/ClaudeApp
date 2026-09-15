/**
 * Shared route-handler plumbing.
 *
 * Every API route goes through `handle()` so that a thrown HttpError becomes a
 * correct status code and anything unexpected becomes a 500 with a logged
 * stack rather than an HTML error page.
 */
import { NextResponse } from "next/server";
import { extensionOrigins, getEnv } from "../env";
import { readSessionCookie } from "../auth/cookies";
import { resolveIngestToken, resolveSession, type SessionUser } from "../auth/session";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, "bad_request", details);
export const unauthorized = (message = "Sign in to continue") => new HttpError(401, message, "unauthorized");
export const forbidden = (message = "Not allowed") => new HttpError(403, message, "forbidden");
export const notFound = (message = "Not found") => new HttpError(404, message, "not_found");
export const conflict = (message: string, details?: unknown) => new HttpError(409, message, "conflict", details);
export const tooMany = (message = "Too many requests") => new HttpError(429, message, "rate_limited");

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/** JSON body parser that fails as a 400 instead of throwing a SyntaxError. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw badRequest("Could not read request body");
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest("Body must be a JSON object");
  }
}

export interface RouteContext {
  /** Route params, already awaited. */
  params: Record<string, string>;
  req: Request;
  url: URL;
}

type Handler = (ctx: RouteContext) => Promise<NextResponse | Response>;

type NextRouteArgs = { params?: Promise<Record<string, string>> };

export function handle(fn: Handler) {
  return async (req: Request, args?: NextRouteArgs): Promise<Response> => {
    const url = new URL(req.url);
    try {
      const params = args?.params ? await args.params : {};
      return await fn({ req, url, params });
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: err.status });
      }
      console.error(`[api] ${req.method} ${url.pathname} failed:`, err);
      return NextResponse.json({ error: "Internal server error", code: "internal" }, { status: 500 });
    }
  };
}

/** Requires a signed-in user, via session cookie. Throws HttpError(401). */
export async function requireApiUser(): Promise<SessionUser> {
  const session = await resolveSession(await readSessionCookie());
  if (!session) throw unauthorized();
  return session.user;
}

/**
 * Accepts either a session cookie (the app itself) or an ingest token in
 * `Authorization: Bearer …`, `x-looks-token` or `?token=` (extension,
 * Shortcut, curl).
 */
export async function requireIngestUser(req: Request, url: URL): Promise<SessionUser> {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const raw = bearer || req.headers.get("x-looks-token") || url.searchParams.get("token") || "";
  if (raw) {
    const user = await resolveIngestToken(raw);
    if (!user) throw unauthorized("Invalid or revoked ingest token");
    return user;
  }
  const session = await resolveSession(await readSessionCookie());
  if (!session) throw unauthorized("Provide an ingest token or sign in");
  return session.user;
}

/** CORS headers for the browser extension's capture endpoint. */
export function extensionCors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = extensionOrigins();
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization,content-type,x-looks-token",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === "production";
}
