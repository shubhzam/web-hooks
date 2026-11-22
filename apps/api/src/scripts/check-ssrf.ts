import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isBlockedAddress } from "../services/delivery/address.js";
import { DeliveryFailure } from "../services/delivery/failure.js";
import { createGuardedLookup, createHttpClient } from "../services/delivery/http-client.js";
import { SmokeFailure, check } from "./smoke-kit.js";

// usage: pnpm --filter api check:ssrf (no stack needed)
// table checks of the address rules, then the real http client against a server on 127.0.0.1

const SHOULD_BLOCK = [
  "127.0.0.1",
  "10.0.0.5",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "255.255.255.255",
  "224.0.0.1",
  "198.18.0.1",
  "::1",
  "::",
  "fe80::1",
  "fc00::1",
  "ff02::1",
  "2001:db8::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.5",
  "::ffff:7f00:1",
  "64:ff9b::7f00:1",
  "64:ff9b::a00:5",
];

const SHOULD_ALLOW = ["8.8.8.8", "1.1.1.1", "52.4.118.20", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"];

function checkTable(): void {
  for (const ip of SHOULD_BLOCK) check(`${ip} is blocked`, isBlockedAddress(ip));
  for (const ip of SHOULD_ALLOW) check(`${ip} is allowed`, !isBlockedAddress(ip));
  check("a value that is not an ip is blocked", isBlockedAddress("not-an-ip"));
}

function startTrapServer(): Promise<{ server: Server; port: number; connections: () => number }> {
  let connections = 0;
  const server = createServer((_req, res) => res.writeHead(200).end());
  server.on("connection", () => {
    connections += 1;
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, connections: () => connections });
    });
  });
}

async function failureCodeOf(send: () => Promise<unknown>): Promise<string> {
  try {
    await send();
    return "no error";
  } catch (err) {
    return err instanceof DeliveryFailure ? err.code : "unexpected error";
  }
}

function request(url: string) {
  return { url, deliveryId: "check", timestampSeconds: 1, body: "{}", signature: "v1,x" };
}

async function checkClient(): Promise<void> {
  const trap = await startTrapServer();
  const strict = createHttpClient({ allowHosts: [], timeoutMs: 3000, userAgent: "check", responseCapBytes: 1024 });
  const targets: Array<[string, string]> = [
    ["a hostname that resolves to loopback", `https://localhost:${trap.port}/`],
    ["the ip literal 127.0.0.1", `https://127.0.0.1:${trap.port}/`],
    ["the numeric host 2130706433", `https://2130706433:${trap.port}/`],
    ["the hex host 0x7f000001", `https://0x7f000001:${trap.port}/`],
    ["the metadata ip 169.254.169.254", "https://169.254.169.254/"],
    ["the ipv6 literal [::1]", `https://[::1]:${trap.port}/`],
    ["the mapped literal [::ffff:127.0.0.1]", `https://[::ffff:127.0.0.1]:${trap.port}/`],
    ["plain http to a host that is not allowed", `http://localhost:${trap.port}/`],
  ];
  try {
    for (const [label, url] of targets) {
      const code = await failureCodeOf(() => strict.send(request(url)));
      check(`${label} fails with blocked_address`, code === "blocked_address", `got ${code}`);
    }
    check("the trap server saw zero connections", trap.connections() === 0, `saw ${trap.connections()}`);
    await checkAllowList(trap.port, trap.connections);
  } finally {
    await strict.close();
    trap.server.close();
  }
}

// the allow list is the only way past the guard, and it proves the lookup answers a real connect
async function checkAllowList(port: number, connections: () => number): Promise<void> {
  const open = createHttpClient({ allowHosts: ["localhost"], timeoutMs: 3000, userAgent: "check", responseCapBytes: 1024 });
  try {
    const response = await open.send(request(`http://localhost:${port}/`));
    check("an allow listed host can use http", response.status === 200, `got ${response.status}`);
    check("and the server saw that one connection", connections() === 1, `saw ${connections()}`);
  } finally {
    await open.close();
  }
}

type LookupAnswer = { error: Error | null; address: unknown; family: unknown };

function askLookup(allowHost: boolean, all: boolean): Promise<LookupAnswer> {
  const lookup = createGuardedLookup(new Set(allowHost ? ["localhost"] : []));
  return new Promise((resolve) => {
    lookup("localhost", { all, family: 4 }, (error, address, family) => resolve({ error, address, family }));
  });
}

async function checkLookupShapes(): Promise<void> {
  const blockedAll = await askLookup(false, true);
  check("lookup with all=true rejects a loopback answer", blockedAll.error instanceof DeliveryFailure);
  const blockedOne = await askLookup(false, false);
  check("lookup with all=false rejects a loopback answer", blockedOne.error instanceof DeliveryFailure);
  const allowedAll = await askLookup(true, true);
  check("an allowed host answers all=true with a list of addresses", Array.isArray(allowedAll.address) && allowedAll.address.length > 0);
  const allowedOne = await askLookup(true, false);
  check("an allowed host answers all=false with an address and a family", typeof allowedOne.address === "string" && allowedOne.family === 4);
}

async function main(): Promise<void> {
  try {
    checkTable();
    await checkClient();
    await checkLookupShapes();
    console.log("check ssrf passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`check ssrf crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  }
}

await main();
