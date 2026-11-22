import { isIP } from "node:net";

// pure: true for every address a webhook must never be sent to. unknown input counts as blocked

// [first address, prefix length]
const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  // includes 255.255.255.255
  ["240.0.0.0", 4],
];

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

function inRange(address: number, [first, prefix]: [string, number]): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(ipv4ToNumber(first) / size);
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return BLOCKED_IPV4.some((range) => inRange(value, range));
}

// expands to 8 groups. a trailing dotted quad (::ffff:127.0.0.1) becomes its two hex groups
function parseIpv6(raw: string): number[] | null {
  let text = raw.split("%")[0] ?? "";
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const value = ipv4ToNumber(tail);
    text = `${text.slice(0, lastColon + 1)}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const head = toGroups(halves[0] ?? "");
  const rest = toGroups(halves[1] ?? "");
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return groups.some((group) => Number.isNaN(group)) ? null : groups;
}

function embeddedIpv4(groups: number[]): string {
  const [high = 0, low = 0] = groups.slice(6);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function startsWithZeros(groups: number[], count: number): boolean {
  return groups.slice(0, count).every((group) => group === 0);
}

function isBlockedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  const [first = 0, second = 0] = groups;
  // :: and ::1 fall in the first branch, and the rest of ::/96 carries an ipv4 address
  if (startsWithZeros(groups, 6)) return isBlockedIpv4(embeddedIpv4(groups)) || groups[7] === 1;
  const isMapped = startsWithZeros(groups, 5) && groups[5] === 0xffff;
  const isNat64 = first === 0x64 && second === 0xff9b && startsWithZeros(groups.slice(2), 4);
  if (isMapped || isNat64) return isBlockedIpv4(embeddedIpv4(groups));
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isMulticast = (first & 0xff00) === 0xff00;
  const isDocumentation = first === 0x2001 && second === 0x0db8;
  return isUniqueLocal || isLinkLocal || isMulticast || isDocumentation;
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}
