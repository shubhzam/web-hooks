import * as z from "zod";

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
});

class Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly healthTimeoutMs: number;

  constructor(env: NodeJS.ProcessEnv) {
    const result = envSchema.safeParse(env);
    if (!result.success) {
      throw new Error(`invalid environment\n${z.prettifyError(result.error)}`);
    }
    this.port = result.data.API_PORT;
    this.databaseUrl = result.data.DATABASE_URL;
    this.redisUrl = result.data.REDIS_URL;
    this.healthTimeoutMs = result.data.HEALTH_TIMEOUT_MS;
  }
}

// fails fast at startup if a required variable is missing
export const config = new Config(process.env);