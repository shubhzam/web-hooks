import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import type {
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
} from "@repo/shared/webhook-endpoint";
import { config } from "../config.js";
import { Prisma } from "../generated/prisma/client.js";
import { notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

const withEventTypes = {
  eventTypes: { select: { eventType: true }, orderBy: { eventType: "asc" } },
} satisfies Prisma.WebhookEndpointInclude;

export type EndpointRow = Prisma.WebhookEndpointGetPayload<{ include: typeof withEventTypes }>;

export interface EndpointPage {
  items: EndpointRow[];
  nextCursor: string | null;
}

// the secret is returned to the caller once and must never be logged
function generateSigningSecret(): string {
  return `${config.signingSecretPrefix}${randomBytes(config.signingSecretRandomBytes).toString("base64")}`;
}

// every read and write goes through this, so another org's rows and deleted rows look the same: missing
function liveScope(organizationId: string, id: string): Prisma.WebhookEndpointWhereInput {
  return { id, organizationId, deletedAt: null };
}

function eventTypeRows(endpointId: string, eventTypes: string[]) {
  return eventTypes.map((eventType) => ({ endpointId, eventType }));
}

export async function createEndpoint(
  organizationId: string,
  input: CreateWebhookEndpointInput,
): Promise<EndpointRow> {
  const id = uuidv7();
  // the nested create runs as one transaction: the endpoint row and its event types, or nothing
  return prisma.webhookEndpoint.create({
    data: {
      id,
      organizationId,
      url: input.url,
      description: input.description,
      signingSecret: generateSigningSecret(),
      eventTypes: { create: input.eventTypes.map((eventType) => ({ eventType })) },
    },
    include: withEventTypes,
  });
}

export async function listEndpoints(
  organizationId: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<EndpointPage> {
  const { limit, cursor } = options;
  // one extra row tells us whether there is a next page
  const rows = await prisma.webhookEndpoint.findMany({
    where: { organizationId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: limit + 1,
    include: withEventTypes,
  });
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

async function findLiveEndpoint(
  db: Prisma.TransactionClient,
  organizationId: string,
  id: string,
): Promise<EndpointRow> {
  const row = await db.webhookEndpoint.findFirst({
    where: liveScope(organizationId, id),
    include: withEventTypes,
  });
  if (!row) throw notFound("webhook endpoint not found");
  return row;
}

export async function getEndpoint(organizationId: string, id: string): Promise<EndpointRow> {
  return findLiveEndpoint(prisma, organizationId, id);
}

export async function updateEndpoint(
  organizationId: string,
  id: string,
  input: UpdateWebhookEndpointInput,
): Promise<EndpointRow> {
  const { eventTypes, ...fields } = input;
  return prisma.$transaction(async (tx) => {
    // updated_at is set by hand so a patch that only changes event types still bumps it
    const { count } = await tx.webhookEndpoint.updateMany({
      where: liveScope(organizationId, id),
      data: { ...fields, updatedAt: new Date() },
    });
    if (count === 0) throw notFound("webhook endpoint not found");

    // eventTypes replaces the whole set, so drop the old rows first
    if (eventTypes) {
      await tx.webhookEndpointEventType.deleteMany({ where: { endpointId: id } });
      await tx.webhookEndpointEventType.createMany({ data: eventTypeRows(id, eventTypes) });
    }
    return findLiveEndpoint(tx, organizationId, id);
  });
}

// soft delete, the row stays so later features can still read its history
export async function deleteEndpoint(organizationId: string, id: string): Promise<void> {
  const { count } = await prisma.webhookEndpoint.updateMany({
    where: liveScope(organizationId, id),
    data: { deletedAt: new Date() },
  });
  if (count === 0) throw notFound("webhook endpoint not found");
}
