import * as z from "zod";

export const dependencyCheckSchema = z.object({
  status: z.enum(["up", "down"]),
  required: z.boolean(),
  latencyMs: z.number().nonnegative(),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "unavailable"]),
  dependencies: z.object({
    postgres: dependencyCheckSchema,
    redis: dependencyCheckSchema,
  }),
});

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;