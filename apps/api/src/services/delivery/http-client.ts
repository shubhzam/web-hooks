import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, request, type Dispatcher } from "undici";
import { config } from "../../config.js";
import { isBlockedAddress } from "./address.js";
import { DeliveryFailure, describeFailure } from "./failure.js";

export interface DeliveryRequest {
  url: string;
  deliveryId: string;
  timestampSeconds: number;
  body: string;
  signature: string;
}

export interface DeliveryResponse {
  status: number;
  durationMs: number;
  // the raw Retry-After header value, parsing it is left to the retry logic
  retryAfter: string | null;
}

export interface HttpClientOptions {
  allowHosts: readonly string[];
  timeoutMs: number;
  userAgent: string;
  responseCapBytes: number;
}

export interface DeliveryHttpClient {
  send(delivery: DeliveryRequest): Promise<DeliveryResponse>;
  close(): Promise<void>;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

// answers in the shape the caller asked for. node's net.connect asks for all addresses when
// autoSelectFamily is on (the default), and for a single address and family otherwise
function reply(
  options: LookupOptions,
  addresses: LookupAddress[],
  callback: Parameters<LookupFunction>[2],
): void {
  const first = addresses[0];
  if (options.all || !first) callback(null, addresses);
  else callback(null, first.address, first.family);
}

// resolves like the system would, then refuses the whole host if any answer is not public.
// this runs inside the connect call, so the address checked is the address the socket uses
export function createGuardedLookup(allowHosts: ReadonlySet<string>): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, options.all ? [] : "");
        return;
      }
      const blocked = !allowHosts.has(hostname.toLowerCase()) && addresses.some((a) => isBlockedAddress(a.address));
      if (blocked) {
        callback(new DeliveryFailure("blocked_address"), options.all ? [] : "");
        return;
      }
      reply(options, addresses, callback);
    });
  };
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new DeliveryFailure("network_error");
  }
}

// ip literals never reach the lookup, so they are checked here. new URL() has already turned
// numeric forms like 2130706433 or 0x7f000001 into dotted form, and brackets are removed for ipv6
function assertAllowedTarget(url: URL, allowHosts: ReadonlySet<string>): void {
  const host = stripBrackets(url.hostname);
  const allowed = allowHosts.has(host);
  if (url.protocol === "http:" && !allowed) throw new DeliveryFailure("blocked_address");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DeliveryFailure("blocked_address");
  if (isIP(host) !== 0 && !allowed && isBlockedAddress(host)) throw new DeliveryFailure("blocked_address");
}

// a repeated header arrives as a list, the first value is the one that counts
function headerValue(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

// reads up to the cap and throws the rest away. a failure here is ignored, the status is already known
async function discardBody(body: Dispatcher.ResponseData["body"], capBytes: number): Promise<void> {
  let read = 0;
  try {
    for await (const chunk of body) {
      read += (chunk as Buffer).length;
      if (read >= capBytes) break;
    }
  } catch {
    // nothing to do
  } finally {
    body.destroy();
  }
}

export function createHttpClient(options: HttpClientOptions): DeliveryHttpClient {
  const allowHosts = new Set(options.allowHosts);
  const agent = new Agent({ connect: { lookup: createGuardedLookup(allowHosts) } });

  async function send(delivery: DeliveryRequest): Promise<DeliveryResponse> {
    const url = parseUrl(delivery.url);
    assertAllowedTarget(url, allowHosts);
    const startedAt = performance.now();
    try {
      // request, not fetch: it takes our dispatcher, and it never follows redirects
      const response = await request(url, {
        method: "POST",
        dispatcher: agent,
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": options.userAgent,
          "webhook-id": delivery.deliveryId,
          "webhook-timestamp": String(delivery.timestampSeconds),
          "webhook-signature": delivery.signature,
        },
        body: delivery.body,
      });
      await discardBody(response.body, options.responseCapBytes);
      return {
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        retryAfter: headerValue(response.headers["retry-after"]),
      };
    } catch (err) {
      throw new DeliveryFailure(describeFailure(err), { cause: err });
    }
  }

  return { send, close: () => agent.close() };
}

export const deliveryClient: DeliveryHttpClient = createHttpClient({
  allowHosts: config.deliveryAllowHosts,
  timeoutMs: config.deliveryTimeoutMs,
  userAgent: config.deliveryUserAgent,
  responseCapBytes: config.deliveryResponseCapBytes,
});
