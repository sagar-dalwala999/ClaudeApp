/** "1830" -> "1 830" (thin-space grouping like the reference UI). */
export function groupThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Bytes -> "1,7 GB" (comma decimal, like the reference UI). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const s = u === 0 ? String(Math.round(v)) : v.toFixed(1).replace(".", ",");
  return `${s} ${units[u]}`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
