import { Router } from "express";
import * as z from "zod";
import {
  createWebhookEndpointSchema,
  listWebhookEndpointsQuerySchema,
  updateWebhookEndpointSchema,
  type CreatedWebhookEndpoint,
  type WebhookEndpoint,
  type WebhookEndpointList,
} from "@repo/shared/webhook-endpoint";
import { notFound } from "../lib/errors.js";
import { organizationIdOf } from "../middleware/auth.js";
import { getEndpointStats } from "../services/deliveries.js";
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  type EndpointRow,
} from "../services/webhook-endpoints.js";

// explicit type so the declaration output doesn't reference pnpm internals
export const webhookEndpointsRouter: Router = Router();

// fields are copied one by one on purpose, spreading the row would leak signing_secret into every response
function toResponse(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.eventTypes.map((item) => item.eventType),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCreatedResponse(row: EndpointRow): CreatedWebhookEndpoint {
  return { ...toResponse(row), signingSecret: row.signingSecret };
}

// a malformed id cannot match anything, so it is a 404 like any other unknown id
function endpointIdFrom(raw: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw notFound("webhook endpoint not found");
  return parsed.data;
}

webhookEndpointsRouter.post("/webhook-endpoints", async (req, res) => {
  const input = createWebhookEndpointSchema.parse(req.body);
  const row = await createEndpoint(organizationIdOf(req), input);
  // the response carries the only copy of the secret we ever hand out
  res.status(201).set("Cache-Control", "no-store").json(toCreatedResponse(row));
});

webhookEndpointsRouter.get("/webhook-endpoints", async (req, res) => {
  const query = listWebhookEndpointsQuerySchema.parse(req.query);
  const page = await listEndpoints(organizationIdOf(req), query);
  const body: WebhookEndpointList = { data: page.items.map(toResponse), nextCursor: page.nextCursor };
  res.json(body);
});

webhookEndpointsRouter.get("/webhook-endpoints/:id", async (req, res) => {
  const row = await getEndpoint(organizationIdOf(req), endpointIdFrom(req.params.id));
  res.json(toResponse(row));
});

// delivery counts of the last 24 hours, loaded apart from the endpoint because counting can be slow
webhookEndpointsRouter.get("/webhook-endpoints/:id/stats", async (req, res) => {
  res.json(await getEndpointStats(organizationIdOf(req), endpointIdFrom(req.params.id)));
});

webhookEndpointsRouter.patch("/webhook-endpoints/:id", async (req, res) => {
  const input = updateWebhookEndpointSchema.parse(req.body);
  const row = await updateEndpoint(organizationIdOf(req), endpointIdFrom(req.params.id), input);
  res.json(toResponse(row));
});

webhookEndpointsRouter.delete("/webhook-endpoints/:id", async (req, res) => {
  await deleteEndpoint(organizationIdOf(req), endpointIdFrom(req.params.id));
  res.status(204).end();
});
