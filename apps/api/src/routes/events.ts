import express, { Router } from "express";
import { ingestEventRequestSchema } from "@repo/shared/event";
import { config } from "../config.js";
import { ingestEvent } from "../services/events.js";

// explicit type so the declaration output doesn't reference pnpm internals
export const eventsRouter: Router = Router();

eventsRouter.post("/", express.json({ limit: config.ingestBodyLimitBytes }), async (req, res) => {
  const input = ingestEventRequestSchema.parse(req.body);
  res.status(202).json(await ingestEvent(input));
});
