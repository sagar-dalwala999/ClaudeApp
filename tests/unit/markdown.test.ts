import { describe, expect, it } from "vitest";
import { buildDailyNote, buildIndexMarkdown, entryToMarkdown, type MarkdownEntry } from "@/server/export/markdown";

const entry: MarkdownEntry = {
  title: "Attention Is All You Need",
  url: "https://arxiv.org/abs/1706.03762",
  type: "paper",
  tags: ["transformers", "nlp"],
  addedDate: "2026-03-04",
  summary: "The transformer paper. It replaces recurrence with attention.",
  note: "for the retrieval project",
  author: "Vaswani et al.",
  siteName: "arXiv",
};

describe("entryToMarkdown", () => {
  it("writes the reference field order", () => {
    expect(entryToMarkdown(entry)).toBe(
      [
        "### Attention Is All You Need",
        "",
        "- **URL**: https://arxiv.org/abs/1706.03762",
        "- **Type**: `paper`",
        "- **Tags**: #transformers #nlp",
        "- **Added**: 2026-03-04",
        "- **Author**: Vaswani et al.",
        "- **Source**: arXiv",
        "- **Note**: for the retrieval project",
        "- **Summary**: The transformer paper. It replaces recurrence with attention.",
      ].join("\n"),
    );
  });

  it("omits the optional fields when they are empty", () => {
    const plain = entryToMarkdown({ ...entry, author: null, siteName: null, note: undefined });
    expect(plain).not.toContain("**Author**");
    expect(plain).not.toContain("**Source**");
    expect(plain).not.toContain("**Note**");
  });

  it("marks a link whose content could not be fetched", () => {
    expect(entryToMarkdown({ ...entry, summary: "" })).toContain("- **Summary**: [content unavailable]");
  });

  it("uses the URL as the heading when there is no title", () => {
    expect(entryToMarkdown({ ...entry, title: "" }).startsWith("### https://arxiv.org/abs/1706.03762")).toBe(true);
  });

  it("flattens newlines so one entry stays one block", () => {
    expect(entryToMarkdown({ ...entry, summary: "line one\nline  two" })).toContain("**Summary**: line one line two");
  });
});

describe("buildIndexMarkdown", () => {
  const entries: MarkdownEntry[] = [
    { ...entry, title: "Newer", addedDate: "2026-03-05" },
    { ...entry, title: "Older", addedDate: "2026-03-04" },
    { ...entry, title: "Same day", addedDate: "2026-03-04" },
  ];

  it("groups by day, newest first, without touching the order within a day", () => {
    const index = buildIndexMarkdown(entries);
    expect(index.startsWith("# Index")).toBe(true);
    expect(index).toContain("3 entries.");
    expect(index.indexOf("## 2026-03-05")).toBeLessThan(index.indexOf("## 2026-03-04"));
    expect(index.indexOf("### Older")).toBeLessThan(index.indexOf("### Same day"));
  });

  it("says 'entry' when there is exactly one", () => {
    expect(buildIndexMarkdown([entry])).toContain("1 entry.");
  });

  it("still produces a valid file for an empty archive", () => {
    const index = buildIndexMarkdown([]);
    expect(index).toContain("# Index");
    expect(index).toContain("0 entries.");
  });
});

describe("buildDailyNote", () => {
  it("is a session snapshot, not another index", () => {
    const day = buildDailyNote("2026-03-04", [entry, { ...entry, title: "Second" }]);
    expect(day.startsWith("# 2026-03-04")).toBe(true);
    expect(day).toContain("2 links saved.");
    expect(day).toContain("### Attention Is All You Need");
    expect(day).toContain("### Second");
  });
});
