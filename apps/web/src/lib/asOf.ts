const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Nov, 14:05 UTC": UTC so the static page and the browser print the same text. */
export function formatAsOf(ms: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hm} UTC`;
}
