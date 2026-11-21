import * as z from "zod";
import { Prisma } from "../generated/prisma/client.js";

// must match the partial unique index created by hand in the webhook_registration migration
const URL_INDEX_NAME = "webhook_endpoints_organization_id_url_live_key";

// prisma 7 with the pg adapter sets code P2002 but no meta.target, the postgres detail
// (sqlstate 23505 and the index name) sits under meta.driverAdapterError.cause
const uniqueViolationMetaSchema = z.object({
  driverAdapterError: z.object({
    cause: z.object({
      originalCode: z.literal("23505"),
      constraint: z.object({ index: z.string() }),
    }),
  }),
});

export function isEndpointUrlViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const meta = uniqueViolationMetaSchema.safeParse(err.meta);
  return meta.success && meta.data.driverAdapterError.cause.constraint.index === URL_INDEX_NAME;
}
