// the smallest uuidv7 that can belong to a given moment: the 48 bit millisecond timestamp, the
// version nibble 7, the variant bits 10 and zeros everywhere else. every uuidv7 made at or after
// that millisecond sorts at or above it, and every one made before it sorts below. postgres
// compares uuids byte by byte, which is the same order as the hex text below
const TIMESTAMP_HEX_LENGTH = 12;
const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

export function uuidv7LowerBound(date: Date): string {
  const ms = date.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) {
    throw new RangeError("date does not fit in a 48 bit millisecond timestamp");
  }
  const hex = ms.toString(16).padStart(TIMESTAMP_HEX_LENGTH, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
}
