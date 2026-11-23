import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { describeError } from "./lib/describe-error.js";
import { prisma } from "./lib/prisma.js";
import { closeBreaker } from "./services/delivery/breaker.js";
import { deliver, type DeliveryJob } from "./services/delivery/deliver.js";
import { deliveryClient } from "./services/delivery/http-client.js";
import { claimDeliveries, loadContext, reapExpired, type ClaimedDelivery } from "./services/delivery/repository.js";

// claims pending deliveries, sends them with a bounded number in flight, and recovers deliveries
// whose worker died. there is no http server here, so there is no /health for this process

const inFlight = new Set<Promise<void>>();
// aborted on shutdown, it wakes every pause so the loop can end
const stopSignal = new AbortController();
let reaperTimer: NodeJS.Timeout | undefined;
let reaping = false;

function isStopping(): boolean {
  return stopSignal.signal.aborted;
}

async function pause(ms: number): Promise<void> {
  await sleep(ms, undefined, { signal: stopSignal.signal }).catch(() => undefined);
}

function start(job: DeliveryJob): void {
  const task: Promise<void> = deliver(job, deliveryClient).finally(() => {
    inFlight.delete(task);
  });
  inFlight.add(task);
}

// claimed rows that cannot be started (context missing) keep their lease and are recovered by the reaper
async function claimAndStart(limit: number): Promise<number> {
  const claimed: ClaimedDelivery[] = await claimDeliveries(limit);
  if (claimed.length === 0) return 0;
  const contexts = await loadContext(claimed);
  for (const delivery of claimed) {
    const context = contexts.get(delivery.id);
    if (context) start({ claimed: delivery, context });
    else console.error(`delivery id=${delivery.id} context missing, left to lease recovery`);
  }
  return claimed.length;
}

async function runLoop(): Promise<void> {
  while (!isStopping()) {
    const free = config.deliveryConcurrency - inFlight.size;
    if (free <= 0) {
      await Promise.race(inFlight);
      continue;
    }
    const limit = Math.min(free, config.deliveryClaimBatchSize);
    try {
      // a full batch means there is probably more waiting, so go again without sleeping
      if ((await claimAndStart(limit)) === limit) continue;
    } catch (err) {
      console.error(`claim failed: ${describeError(err)}`);
      await pause(config.deliveryErrorPauseMs);
      continue;
    }
    await pause(config.deliveryPollIntervalMs);
  }
}

async function reapOnce(): Promise<void> {
  if (reaping || isStopping()) return;
  reaping = true;
  try {
    const { requeued, exhausted } = await reapExpired();
    if (requeued > 0 || exhausted > 0) console.log(`reaper requeued=${requeued} exhausted=${exhausted}`);
  } catch (err) {
    console.error(`reaper failed: ${describeError(err)}`);
  } finally {
    reaping = false;
  }
}

// stop claiming, let the requests that are already out finish, then leave. whatever is still
// running after the deadline keeps its lease, and the reaper of another worker recovers it
async function shutdown(signal: string): Promise<void> {
  if (isStopping()) return;
  stopSignal.abort();
  clearInterval(reaperTimer);
  console.log(`${signal} received, waiting for ${inFlight.size} in-flight deliveries`);
  const deadline = new Promise<false>((resolve) => setTimeout(() => resolve(false), config.deliveryShutdownMs));
  const drained = await Promise.race([Promise.allSettled([...inFlight]).then(() => true), deadline]);
  if (!drained) console.warn(`shutdown deadline reached with ${inFlight.size} deliveries still in flight`);
  await Promise.race([prisma.$disconnect().catch(() => undefined), sleep(2000)]);
  await closeBreaker();
  console.log("delivery worker stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`delivery worker starting concurrency=${config.deliveryConcurrency} allowedHosts=${config.deliveryAllowHosts.length}`);
reaperTimer = setInterval(() => void reapOnce(), config.deliveryReaperIntervalMs);
await runLoop();
