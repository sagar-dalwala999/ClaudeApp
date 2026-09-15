/**
 * The archive wall.
 *
 * A server component, so the first page of items, the collections and the
 * counts are in the HTML that arrives: the canvas paints immediately instead
 * of after a round trip.
 */
import { Archive } from "@/components/Archive";
import { requireUser } from "@/server/auth/guard";
import { getItems, listItems } from "@/server/db/queries/items";
import { libraryStats, listCollectionPreviews, listCollections } from "@/server/db/queries/library";
import { toClientItem, type ClientItem } from "@/lib/item";

export const dynamic = "force-dynamic";

const FIRST_PAGE = 120;

export default async function Page() {
  const user = await requireUser();

  const [page, collections, stats, previewPairs, recentPage] = await Promise.all([
    listItems({ userId: user.id, limit: FIRST_PAGE }),
    listCollections(user.id),
    libraryStats(user.id),
    listCollectionPreviews(user.id).catch(() => []),
    listItems({ userId: user.id, limit: 12 }),
  ]);

  const previewIds = [...new Set(previewPairs.map((pair) => pair.itemId))];
  const previewRecords = previewIds.length ? await getItems(user.id, previewIds) : [];
  const previewById = new Map(previewRecords.map((record) => [record.id, toClientItem(record)]));

  const previews: Record<string, ClientItem[]> = {};
  for (const pair of previewPairs) {
    const item = previewById.get(pair.itemId);
    if (!item) continue;
    (previews[pair.collectionId] ??= []).push(item);
  }

  return (
    <Archive
      initialItems={page.items.map(toClientItem)}
      initialCursor={page.nextCursor}
      initialCollections={collections}
      initialPreviews={previews}
      initialRecent={recentPage.items.map(toClientItem)}
      counts={stats}
      defaultCollectionId="everything"
    />
  );
}
