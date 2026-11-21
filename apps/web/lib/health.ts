import { healthResponseSchema, type HealthResponse } from "@repo/shared/health";
import { config } from "./config";

// a 503 still carries a valid body, so only a network failure or a bad body returns null
export async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${config.apiUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return healthResponseSchema.parse(await res.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`health fetch failed: ${message}`);
    return null;
  }
}