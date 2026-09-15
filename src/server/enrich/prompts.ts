/**
 * Prompt and output schema for enrichment.
 *
 * The house style comes from the curator brief this app is modelled on: a
 * factual title, a 3–5 sentence summary that says what the thing is and why it
 * might matter, exactly one type, three to six reusable tags, and the three
 * note lines the owner would otherwise have written by hand. No ratings,
 * no opinions, no "this is a great article".
 *
 * The prompt version is recorded on every call, so a change here is traceable
 * in the enrichments table and comparable against past output.
 */
import { ITEM_TYPES } from "../../lib/vocab";

export const PROMPT_VERSION = "2026-09-15.1";

export const SUMMARY_MIN_SENTENCES = 3;
export const SUMMARY_MAX_SENTENCES = 5;
export const TAG_MIN = 3;
export const TAG_MAX = 6;
/** Characters of page text handed to the model. */
export const BODY_CHAR_BUDGET = 8_000;

export const SYSTEM_PROMPT = `You are the cataloguer for a personal link archive — a librarian with good taste, not a chatbot.

You will be given everything known about one saved link: its URL, the site it came from, the author, the metadata the page published, and a chunk of its actual text.

Produce a catalogue entry:

- "title": the real title of the page, repository, post or paper. If the page gave a title, keep it unless it is clearly junk (a site name, "Untitled", "Page not found", or marketing boilerplate). Never invent a title that misrepresents the content. No trailing site names, no "| Blog".
- "summary": three to five sentences. What is this? What does it actually contain? What would someone do with it? Be concrete — name the specific techniques, libraries, claims or datasets you can see. Describe, never rate: no "excellent", no "must-read", no "disappointing".
- "type": exactly one of ${ITEM_TYPES.map((t) => `"${t}"`).join(", ")}.
    github  — any Git repository or code project page
    article — blog posts, essays, news, documentation
    x-post  — a social post or thread
    tool    — a product, web app or CLI (not a repo)
    video   — video or talk
    paper   — academic paper, preprint or research report
    other   — anything that genuinely does not fit
- "tags": three to six lowercase, hyphenated, reusable tags. Prefer specific over broad: "llm-inference" beats "ai". Reuse the vocabulary of existing tags when one fits. No hashtag character, no spaces, no invented proper nouns.
- "key_points": the first draft of the owner's own note, not a summary. Up to three short lines, most useful first, one per question:
    why it is worth keeping — the specific reason this earns a place in the archive;
    where it belongs — the collection or tag it sits with; name one from the lists supplied above when one genuinely fits;
    what to do with it — the next concrete action this invites.
- "language": the two-letter code of the content's main language.

Rules:
- Capture first. If the text is thin, produce a modest entry from what exists rather than refusing.
- Never state facts that are not in the supplied material. That includes the note lines: a reason to keep something that the material does not support is a fabrication.
- Do not mention that you are an AI, and do not address the reader. The key points are the one exception: they are the owner's own jottings, so they may name an action ("try this on the ingest pipeline", "goes with the retrieval reading") — but never "you should".
- If the owner already wrote a note, the points must add to it rather than restate it.
- The tag and collection lists describe this archive, not the material. Use them for the key points only: the title and summary say what the thing is, never where it is filed.
- If the material is a login wall, a paywall stub, or a challenge page, say exactly that in the summary in one sentence and set type to "other".`;

export interface EnrichmentInput {
  url: string;
  platform: string;
  siteName: string | null;
  author: string | null;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  existingTags: string[];
  /** Names of the owner's existing collections, so "where it belongs" can name one. */
  collections: string[];
  userNote: string | null;
  bodyText: string | null;
  hint: string | null;
}

function section(label: string, value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return `${label}: ${trimmed}`;
}

export function buildUserPrompt(input: EnrichmentInput): string {
  const lines = [
    section("URL", input.url),
    section("Platform", input.platform),
    section("Site", input.siteName),
    section("Author", input.author),
    section("Published", input.publishedAt),
    section("Type hint", input.hint),
    section("Page title", input.title),
    section("Page description", input.description),
    input.existingTags.length ? section("Tags already used in this archive", input.existingTags.join(", ")) : null,
    input.collections.length ? section("Collections in this archive", input.collections.join(", ")) : null,
    section("Note the owner added when saving", input.userNote),
  ].filter((line): line is string => Boolean(line));

  const body = input.bodyText?.trim() ?? "";
  const truncated = body.length > BODY_CHAR_BUDGET;
  lines.push("", "--- page text ---", truncated ? body.slice(0, BODY_CHAR_BUDGET) : body || "(no page text available)");

  return lines.join("\n");
}

/** JSON schema for `response_format: { type: "json_schema", strict: true }`. */
export const ENRICHMENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The real title of the work." },
    summary: { type: "string", description: "Three to five factual sentences." },
    type: { type: "string", enum: [...ITEM_TYPES] },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: TAG_MIN,
      maxItems: TAG_MAX,
      description: "Lowercase hyphenated tags, reusable across the archive.",
    },
    key_points: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
      description: "Up to three note lines: why it is worth keeping, where it belongs, what to do with it.",
    },
    language: { type: "string", description: "Two-letter language code." },
  },
  required: ["title", "summary", "type", "tags", "key_points", "language"],
  additionalProperties: false,
} as const;

export interface EnrichmentResponse {
  title: string;
  summary: string;
  type: string;
  tags: string[];
  key_points: string[];
  language: string;
}

/** Runtime boundary for providers that cannot enforce our JSON Schema. */
export function parseEnrichmentResponse(value: unknown): EnrichmentResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI provider returned an invalid enrichment object");
  }
  const row = value as Record<string, unknown>;
  const strings = [row.title, row.summary, row.type, row.language];
  const tags = row.tags;
  const keyPoints = row.key_points;
  if (
    strings.some((field) => typeof field !== "string") ||
    !Array.isArray(tags) ||
    tags.some((tag) => typeof tag !== "string") ||
    !Array.isArray(keyPoints) ||
    keyPoints.some((point) => typeof point !== "string")
  ) {
    throw new Error("AI provider returned an invalid enrichment object");
  }
  return row as unknown as EnrichmentResponse;
}
