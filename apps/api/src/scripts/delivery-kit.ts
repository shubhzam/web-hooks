import { randomBytes, randomUUID } from "node:crypto";
import * as z from "zod";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { waitUntil } from "./smoke-kit.js";

// shared pieces of the delivery smoke scripts: the mock receiver, seeding, and a cleanup that
// waits for the worker. the worker keeps retrying failed deliveries in the background, so rows
// cannot be deleted while it may still touch them

export const MOCK_FROM_SCRIPT = `http://localhost:${config.mockReceiverPort}`;
// the worker runs in a container, so it reaches the mock by its service name
export const MOCK_FROM_WORKER = "http://mock-receiver:4000";

const QUIESCE_WAIT_MS = 60000;
// a retry date nobody will reach, parks pending rows where the worker cannot claim them
export const FAR_FUTURE = new Date("2100-01-01T00:00:00Z");

const receivedSchema = z.array(
  z.object({
    path: z.string(),
    query: z.string(),
    headers: z.object({ "webhook-id": z.string(), "webhook-timestamp": z.string(), "webhook-signature": z.string() }),
    body: z.string(),
    time: z.string(),
  }),
);

export type ReceivedRequest = z.infer<typeof receivedSchema>[number];

export async function fetchReceived(path: string): Promise<ReceivedRequest[]> {
  const res = await fetch(`${MOCK_FROM_SCRIPT}/received?path=${encodeURIComponent(path)}`);
  return receivedSchema.parse(await res.json());
}

export async function clearReceived(): Promise<void> {
  await fetch(`${MOCK_FROM_SCRIPT}/received`, { method: "DELETE" });
}

export function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

export async function seedEvent(organizationId: string): Promise<{ eventId: string; payload: { invoiceId: string; amountCents: number } }> {
  const eventId = randomUUID();
  const payload = { invoiceId: "inv_delivery_smoke", amountCents: 4200 };
  await prisma.event.create({
    data: {
      eventId,
      organizationId,
      type: "invoice.paid",
      payload,
      occurredAt: new Date(Date.now() - 5000),
      receivedAt: new Date(),
    },
  });
  return { eventId, payload };
}

// parks every waiting retry and waits until no delivery of these organizations is in flight.
// one query looks at both states, so a row that finishes and becomes pending again is seen
async function quiesce(organizationIds: string[]): Promise<void> {
  const organizationId = { in: organizationIds };
  await waitUntil(
    async () => {
      await prisma.delivery.updateMany({
        where: { organizationId, status: "pending", nextAttemptAt: { lt: FAR_FUTURE } },
        data: { nextAttemptAt: FAR_FUTURE },
      });
      const busy = await prisma.delivery.count({
        where: {
          organizationId,
          OR: [{ status: "in_progress" }, { status: "pending", nextAttemptAt: { lt: FAR_FUTURE } }],
        },
      });
      return busy === 0;
    },
    QUIESCE_WAIT_MS,
    200,
  );
}

// deletes the rows without waiting for the worker, for scripts whose rows the worker can never reach
export async function deleteOrganizationRows(organizationIds: string[]): Promise<void> {
  const organizationId = { in: organizationIds };
  await prisma.deliveryAttempt.deleteMany({ where: { delivery: { organizationId } } });
  await prisma.delivery.deleteMany({ where: { organizationId } });
  await prisma.event.deleteMany({ where: { organizationId } });
  await prisma.webhookEndpoint.deleteMany({ where: { organizationId } });
  await prisma.apiKey.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

// removes everything a smoke script seeded
export async function removeOrganizations(organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  try {
    await quiesce(organizationIds);
    await deleteOrganizationRows(organizationIds);
  } catch (err) {
    console.error(`smoke cleanup failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
}
