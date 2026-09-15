/**
 * Markdown export.
 *
 * Reproduces the vault layout this app is modelled on: an `INDEX.md` holding
 * every entry newest first, plus one `YYYY-MM-DD.md` per day. Fields and order
 * match the original brief exactly, so an existing Obsidian workflow keeps
 * working and the archive can be rebuilt from the files.
 */
import { listItems } from "../db/queries/items";

export interface MarkdownEntry {
  title: string;
  url: string;
  type: string;
  tags: string[];
  addedDate: string;
  summary: string;
  note?: string | null;
  author?: string | null;
  siteName?: string | null;
}

export type MarkdownFiles = Record<string, string>;

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** One entry, in the reference format. */
export function entryToMarkdown(entry: MarkdownEntry): string {
  const lines = [
    `### ${clean(entry.title) || clean(entry.url)}`,
    "",
    `- **URL**: ${entry.url}`,
    `- **Type**: \`${entry.type}\``,
    `- **Tags**: ${entry.tags.length ? entry.tags.map((tag) => `#${tag}`).join(" ") : "—"}`,
    `- **Added**: ${entry.addedDate}`,
  ];
  if (entry.author) lines.push(`- **Author**: ${clean(entry.author)}`);
  if (entry.siteName) lines.push(`- **Source**: ${clean(entry.siteName)}`);
  if (entry.note) lines.push(`- **Note**: ${clean(entry.note)}`);
  lines.push(`- **Summary**: ${clean(entry.summary) || "[content unavailable]"}`);
  return lines.join("\n");
}

function groupByDate(entries: MarkdownEntry[]): Map<string, MarkdownEntry[]> {
  const groups = new Map<string, MarkdownEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.addedDate) ?? [];
    list.push(entry);
    groups.set(entry.addedDate, list);
  }
  return groups;
}

export function buildIndexMarkdown(entries: MarkdownEntry[]): string {
  const header = [
    "# Index",
    "",
    `Every saved link, newest first. ${entries.length} ${entries.length === 1 ? "entry" : "entries"}.`,
    "",
  ];
  const groups = [...groupByDate(entries).entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const body = groups.map(([date, dayEntries]) => {
    const entriesForDay = dayEntries.map((entry) => entryToMarkdown(entry)).join("\n\n");
    return `## ${date}\n\n${entriesForDay}`;
  });
  return `${header.join("\n")}${body.join("\n\n")}\n`;
}

export function buildDailyNote(date: string, entries: MarkdownEntry[]): string {
  const header = [`# ${date}`, "", `${entries.length} ${entries.length === 1 ? "link" : "links"} saved.`, ""];
  return `${header.join("\n")}\n${entries.map((entry) => entryToMarkdown(entry)).join("\n\n")}\n`;
}

export interface ExportOptions {
  userId: string;
  /** Cap on entries per file set; a full archive is paged. */
  limit?: number;
}

/** Builds the whole vault in memory: INDEX.md plus one file per day. */
export async function buildMarkdownVault(options: ExportOptions): Promise<MarkdownFiles> {
  const limit = options.limit ?? 500;
  const files: MarkdownFiles = {};
  const entries: MarkdownEntry[] = [];

  let cursor: string | null = null;
  for (let page = 0; page < Math.ceil(limit / 200) + 1; page++) {
    const result = await listItems({ userId: options.userId, limit: 200, cursor, sort: "added" });
    for (const item of result.items) {
      entries.push({
        title: item.title ?? item.url,
        url: item.canonicalUrl || item.url,
        type: item.type,
        tags: item.tags,
        addedDate: item.addedAt.slice(0, 10),
        summary: item.summary ?? "",
        note: item.note,
        author: item.author ?? item.authorHandle,
        siteName: item.siteName,
      });
      if (entries.length >= limit) break;
    }
    cursor = result.nextCursor;
    if (!cursor || entries.length >= limit) break;
  }

  files["INDEX.md"] = buildIndexMarkdown(entries);
  for (const [date, dayEntries] of groupByDate(entries)) {
    files[`${date}.md`] = buildDailyNote(date, dayEntries);
  }
  return files;
}
