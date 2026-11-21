import type { DependencyCheck, HealthResponse } from "@repo/shared/health";
import { config } from "../config.js";
import { prisma } from "./prisma.js";
import { checkBroker } from "./kafka.js";
import { redis } from "./redis.js";

// runs one probe with a timeout, never throws, and logs the real error server side
async function timedCheck(
  name: string,
  required: boolean,
  probe: () => PromiseLike<unknown>,
): Promise<DependencyCheck> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), config.healthTimeoutMs);
      }),
    ]);
    return { status: "up", required, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`health check failed: ${name} - ${message}`);
    return { status: "down", required, latencyMs: Math.round(performance.now() - startedAt) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReadiness(): Promise<HealthResponse> {
  const [postgres, redisCheck, kafka] = await Promise.all([
    timedCheck("postgres", true, () => prisma.$queryRaw`SELECT 1`),
    timedCheck("redis", false, () => redis.ping()),
    timedCheck("kafka", false, () => checkBroker(config.healthTimeoutMs)),
  ]);

  // only required dependencies decide readiness, redis and kafka are reported but optional
  const ready = [postgres, redisCheck, kafka].every((c) => !c.required || c.status === "up");

  return {
    status: ready ? "ok" : "unavailable",
    dependencies: { postgres, redis: redisCheck, kafka },
  };
}