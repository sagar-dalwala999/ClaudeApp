/**
 * Tag hygiene.
 *
 * One normalisation function everywhere, so the vocabulary converges instead
 * of fragmenting into near-duplicates: lowercase, hyphenated, no leading `#`,
 * no spaces. `#Machine Learning`, `machine_learning` and `MachineLearning`
 * all become `machine-learning`.
 */

const MAX_TAG_LENGTH = 48;

export function normalizeTag(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^#+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // camelCase → camel-case
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned.length > MAX_TAG_LENGTH) return cleaned.slice(0, MAX_TAG_LENGTH) || null;
  // Reject tags that carry no meaning at all.
  if (cleaned.length < 2) return null;
  if (/^\d+$/.test(cleaned)) return null;
  return cleaned;
}

/** Human-facing form: `machine-learning` → `Machine learning`. */
export function tagLabel(name: string): string {
  const spaced = name.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    const tag = normalizeTag(candidate);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Conservative singular/plural collapsing, used when reconciling tags. */
export function tagStem(tag: string): string {
  if (tag.length <= 4) return tag;
  if (tag.endsWith("ies")) return `${tag.slice(0, -3)}y`;
  if (tag.endsWith("ses") || tag.endsWith("xes") || tag.endsWith("ches")) return tag.slice(0, -2);
  if (tag.endsWith("s") && !tag.endsWith("ss")) return tag.slice(0, -1);
  return tag;
}
