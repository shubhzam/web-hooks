import { V7Generator, uuidv7 } from "uuidv7";
import * as z from "zod";
import {
  deliveryDetailSchema,
  deliveryListItemSchema,
  deliveryStatusSchema,
  endpointStatsSchema,
  listDeliveriesQuerySchema,
} from "@repo/shared/delivery";
import { DeliveryStatus } from "../generated/prisma/enums.js";
import { uuidv7LowerBound } from "../lib/uuidv7-bound.js";
import { activePause, successRate } from "../services/delivery/stats.js";
import { SmokeFailure, check, sleep } from "./smoke-kit.js";

// usage: pnpm --filter api check:dashboard (no stack needed)
// table checks of the pure parts of the dashboard api: the uuidv7 lower bound, the query
// validation, the stats definitions and the shape of the responses

const KNOWN_BOUNDS: [string, number, string][] = [
  ["the epoch", 0, "00000000-0000-7000-8000-000000000000"],
  ["1700000000000", 1700000000000, "018bcfe5-6800-7000-8000-000000000000"],
  ["the largest 48 bit value", 2 ** 48 - 1, "ffffffff-ffff-7000-8000-000000000000"],
];
const BOUND_MS = Date.UTC(2026, 5, 15, 12, 0, 0, 500);
const REAL_ID_PAUSE_MS = 3;
const ORDERING_ROUNDS = 200;
const UUID_VARIANT_CHARS = "89ab";
const VALID_ID = "0193f6b0-9a1c-7d02-b5e3-1c8f4a6d7e90";

// a fresh generator each time, the shared one keeps ids monotonic and would clamp an older timestamp
function idAt(ms: number): string {
  return new V7Generator().generateOrResetWithTs(ms).toString();
}

function checkKnownBounds(): void {
  for (const [name, ms, expected] of KNOWN_BOUNDS) {
    const bound = uuidv7LowerBound(new Date(ms));
    check(`the bound for ${name} is ${expected}`, bound === expected, bound);
  }
  const bound = uuidv7LowerBound(new Date(BOUND_MS));
  check("the bound has the version nibble 7", bound[14] === "7", bound);
  check("the bound has the variant bits 10", UUID_VARIANT_CHARS.includes(bound[19] ?? ""), bound);
  check("the bound is accepted as a uuid by zod", z.uuid().safeParse(bound).success, bound);
  check("the bound is lowercase 8-4-4-4-12", /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bound), bound);
  check("everything after the timestamp is zero apart from version and variant", bound.slice(15) === "000-8000-000000000000", bound);
  check("the bound for an invalid date throws", throws(() => uuidv7LowerBound(new Date(Number.NaN))));
  check("the bound for a negative time throws", throws(() => uuidv7LowerBound(new Date(-1))));
  check("the bound for a time past 48 bits throws", throws(() => uuidv7LowerBound(new Date(2 ** 48))));
}

function throws(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

function checkOrdering(): void {
  const bound = uuidv7LowerBound(new Date(BOUND_MS));
  // the random bits differ every time, so each case is tried many times
  const rounds = Array.from({ length: ORDERING_ROUNDS });
  check("200 ids from the millisecond before all sort below the bound", rounds.every(() => idAt(BOUND_MS - 1) < bound));
  check("200 ids from the same millisecond all sort at or above the bound", rounds.every(() => idAt(BOUND_MS) >= bound));
  check("200 ids from the millisecond after all sort above the bound", rounds.every(() => idAt(BOUND_MS + 1) > bound));
}

async function checkRealIds(): Promise<void> {
  const before = uuidv7();
  await sleep(REAL_ID_PAUSE_MS);
  const boundary = new Date();
  await sleep(REAL_ID_PAUSE_MS);
  const after = uuidv7();
  const bound = uuidv7LowerBound(boundary);
  check("a real uuidv7 made just before the boundary sorts below the bound", before < bound, `${before} ${bound}`);
  check("a real uuidv7 made just after the boundary sorts above the bound", after > bound, `${after} ${bound}`);
  check("the bound of a later moment sorts above the bound of an earlier one", uuidv7LowerBound(new Date(BOUND_MS + 1)) > uuidv7LowerBound(new Date(BOUND_MS)));
}

function parses(input: Record<string, unknown>): boolean {
  return listDeliveriesQuerySchema.safeParse(input).success;
}

function checkQueryValidation(): void {
  const empty = listDeliveriesQuerySchema.parse({});
  check("an empty query is accepted with a limit of 50", empty.limit === 50 && empty.cursor === undefined);
  check("a uuid cursor is accepted", parses({ cursor: VALID_ID }));
  for (const bad of ["abc", "", "0193f6b0-9a1c-7d02-b5e3", `${VALID_ID}0`, "not-a-uuid-at-all-not-a-uuid-at-all!"]) {
    check(`the cursor "${bad}" is rejected`, !parses({ cursor: bad }));
  }
  check("an array cursor is rejected", !parses({ cursor: [VALID_ID, VALID_ID] }));
  check("a string limit is coerced", listDeliveriesQuerySchema.parse({ limit: "100" }).limit === 100);
  for (const bad of ["0", "101", "-1", "abc", "1.5", ""]) {
    check(`the limit "${bad}" is rejected`, !parses({ limit: bad }));
  }
  check("a bad endpointId is rejected", !parses({ endpointId: "nope" }));
  check("a bad eventType is rejected", !parses({ eventType: "Not A Type" }));
  check("a good eventType is accepted", parses({ eventType: "invoice.paid" }));
  check("an unknown status is rejected", !parses({ status: "failed" }));
  for (const status of ["pending", "in_progress", "succeeded", "exhausted"]) {
    check(`the status ${status} is accepted`, parses({ status }));
  }
  check("all filters together are accepted", parses({ endpointId: VALID_ID, status: "exhausted", eventType: "invoice.paid", cursor: VALID_ID, limit: "25" }));
}

function checkStatusEnum(): void {
  const fromSchema = [...deliveryStatusSchema.options].sort();
  const fromPrisma = Object.values(DeliveryStatus).sort();
  check("the shared status enum matches schema.prisma", JSON.stringify(fromSchema) === JSON.stringify(fromPrisma), `${fromSchema} vs ${fromPrisma}`);
}

function checkStatsDefinitions(): void {
  check("no finished deliveries is a null success rate", successRate(0, 0) === null);
  check("3 succeeded and 1 exhausted is 0.75", successRate(3, 1) === 0.75);
  check("only exhausted is 0", successRate(0, 5) === 0);
  check("only succeeded is 1", successRate(5, 0) === 1);
  const now = new Date(BOUND_MS);
  const future = new Date(BOUND_MS + 1000);
  check("a pause in the future is reported", activePause(future, now)?.getTime() === future.getTime());
  check("a pause that has passed is null", activePause(new Date(BOUND_MS - 1000), now) === null);
  check("a pause that ends right now is null", activePause(now, now) === null);
  check("no pause is null", activePause(null, now) === null);
}

function checkSchemasLeakNothing(): void {
  const shapes = [deliveryListItemSchema.shape, deliveryDetailSchema.shape, endpointStatsSchema.shape];
  const keys = shapes.flatMap((shape) => Object.keys(shape));
  check("no response schema names a secret", !keys.some((key) => /secret|token|key|url/i.test(key)), keys.join(","));
  check("the list item has no payload", !("payload" in deliveryListItemSchema.shape) && !("event" in deliveryListItemSchema.shape));
  check("the detail has the event with its payload", "payload" in deliveryDetailSchema.shape.event.shape);
}

async function main(): Promise<void> {
  try {
    checkKnownBounds();
    checkOrdering();
    await checkRealIds();
    checkQueryValidation();
    checkStatusEnum();
    checkStatsDefinitions();
    checkSchemasLeakNothing();
    console.log("check dashboard passed");
  } catch (err) {
    if (!(err instanceof SmokeFailure)) {
      console.error(`check dashboard crashed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exitCode = 1;
  }
}

void main();
