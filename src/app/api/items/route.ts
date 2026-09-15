/**
 * GET  /api/items  — paged list with filters
 * POST /api/items  — save a link (the paste path)
 */
import { getItemByIdentity, listItems, type ListOptions } from "@/server/db/queries/items";
import { badRequest, handle, json, readJson, requireApiUser } from "@/server/http/respond";
import { enumField, numberField, optionalString, queryString, requiredString } from "@/server/http/validate";
import { ingestUrl } from "@/server/ingest";
import { InvalidUrlError, normalizeUrlInput } from "@/server/normalize/url";

export const dynamic = "force-dynamic";

const SORTS = ["added", "oldest", "author", "title"] as const;
const STATUSES = ["pending", "ready", "unread", "failed"] as const;

export const GET = handle(async ({ req, url }) => {
  const user = await requireApiUser();
  void req;

  const options: ListOptions = {
    userId: user.id,
    collectionId: queryString(url, "collectionId", 60),
    tag: queryString(url, "tag", 80),
    type: queryString(url, "type", 20),
    status: enumField(queryString(url, "status", 20), STATUSES, "status"),
    favoriteOnly: queryString(url, "favorite") === "1",
    sort: enumField(queryString(url, "sort"), SORTS, "sort") ?? "added",
    cursor: queryString(url, "cursor", 200),
    limit: numberField(queryString(url, "limit"), 60, 1, 200, "limit"),
  };

  const result = await listItems(options);
  return json({ items: result.items, nextCursor: result.nextCursor });
});

export const POST = handle(async ({ req }) => {
  const user = await requireApiUser();
  const body = await readJson(req);

  const input = requiredString(body.url, "url", 4000);
  const collectionId = optionalString(body.collectionId, "collectionId", 60) ?? null;
  // A duplicate URL is a normal outcome, not an error — the UI says so.
  const force = body.force === true;

  if (!force) {
    try {
      const normalizedInput = normalizeUrlInput(input);
      const existing = await getItemByIdentity(user.id, normalizedInput.identityKey);
      if (existing) return json({ item: existing, created: false, duplicate: true });
    } catch (err) {
      if (err instanceof InvalidUrlError) throw badRequest(err.message);
      throw err;
    }
  }

  const result = await ingestUrl({ userId: user.id, input, collectionId, source: "paste" });
  return json(
    { item: result.item, created: result.created, duplicate: !result.created },
    { status: result.created ? 201 : 200 },
  );
});
