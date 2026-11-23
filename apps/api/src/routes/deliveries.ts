import { Router } from "express";
import * as z from "zod";
import { listDeliveriesQuerySchema, type ReplayDeliveryResponse } from "@repo/shared/delivery";
import { notFound } from "../lib/errors.js";
import { organizationIdOf } from "../middleware/auth.js";
import { getDeliveryDetail, listDeliveryPage, replayExhaustedDelivery } from "../services/deliveries.js";

// explicit type so the declaration output doesn't reference pnpm internals
export const deliveriesRouter: Router = Router();

// a malformed id cannot match anything, so it is a 404 like any other unknown id
function deliveryIdFrom(raw: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw notFound("delivery not found");
  return parsed.data;
}

// a bad filter or cursor is a 400 through the zod error handler
deliveriesRouter.get("/deliveries", async (req, res) => {
  const query = listDeliveriesQuerySchema.parse(req.query);
  res.json(await listDeliveryPage(organizationIdOf(req), query));
});

deliveriesRouter.get("/deliveries/:id", async (req, res) => {
  res.json(await getDeliveryDetail(organizationIdOf(req), deliveryIdFrom(req.params.id)));
});

deliveriesRouter.post("/deliveries/:id/replay", async (req, res) => {
  const deliveryId = deliveryIdFrom(req.params.id);
  await replayExhaustedDelivery(organizationIdOf(req), deliveryId);
  const body: ReplayDeliveryResponse = { deliveryId, status: "pending" };
  res.status(202).json(body);
});
