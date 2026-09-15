/**
 * The model's note lines, rendered as the first draft of an item's note.
 *
 * The summary stays prose; the note lines are the owner's field. A draft is
 * only ever written over an empty note or over one that is still a draft we
 * wrote, so the first edit the owner makes ends the AI's interest in the note.
 */

/** One `·`-prefixed line per point. Points that carry no text are dropped. */
export function renderNoteSeed(points: string[]): string {
  return points
    .map((point) => point.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((point) => `· ${point}`)
    .join("\n");
}

/**
 * The note to write, or `undefined` to leave the note exactly as it is.
 * `currentIsDraft` says whether the stored note is still one of our drafts.
 */
export function noteSeed(points: string[], current: string | null, currentIsDraft: boolean): string | undefined {
  const seed = renderNoteSeed(points);
  if (!seed) return undefined;
  const note = current ?? "";
  return note.trim() === "" || currentIsDraft ? seed : undefined;
}