/** URL- and filename-safe slug. Unicode letters are preserved. */
export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `collection-${Date.now().toString(36)}`;
}
