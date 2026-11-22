import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// dev and test only: a fake customer server for the delivery smoke scripts. it keeps every
// request it receives in memory so a script can ask what arrived. it is standalone on purpose,
// it does not load the app config, which would demand database and kafka settings

const LISTEN_PORT = Number(process.env["MOCK_RECEIVER_LISTEN_PORT"] ?? 4000);
const DEFAULT_SLOW_MS = 15000;

interface LoggedRequest {
  path: string;
  query: string;
  headers: { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string };
  body: string;
  time: string;
}

const received: LoggedRequest[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function reply(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers).end();
}

function replyJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function handleReceived(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (req.method === "DELETE") {
    received.length = 0;
    reply(res, 204);
    return;
  }
  const path = url.searchParams.get("path");
  replyJson(res, path === null ? received : received.filter((entry) => entry.path === path));
}

function handleSlow(res: ServerResponse, url: URL): void {
  const waitMs = Number(url.searchParams.get("ms") ?? DEFAULT_SLOW_MS);
  const timer = setTimeout(() => reply(res, 200), waitMs);
  // the caller gave up, so stop holding the timer
  res.on("close", () => clearTimeout(timer));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://mock-receiver");
  if (url.pathname === "/received") {
    handleReceived(req, res, url);
    return;
  }
  received.push({
    path: url.pathname,
    query: url.search,
    headers: {
      "webhook-id": header(req, "webhook-id"),
      "webhook-timestamp": header(req, "webhook-timestamp"),
      "webhook-signature": header(req, "webhook-signature"),
    },
    body: await readBody(req),
    time: new Date().toISOString(),
  });
  if (url.pathname === "/fail") reply(res, 500);
  else if (url.pathname === "/slow") handleSlow(res, url);
  else if (url.pathname === "/redirect") reply(res, 302, { location: "/target" });
  else if (["/ok", "/target", "/inactive"].includes(url.pathname)) reply(res, 200);
  else reply(res, 404);
}

createServer((req, res) => void handle(req, res)).listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`mock receiver listening on ${LISTEN_PORT}`);
});
