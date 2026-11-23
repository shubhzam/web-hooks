// builds a query string for a link, leaving out anything that is empty so a link never carries
// "cursor=" or "status="
export function buildQuery(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(name, value);
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}
