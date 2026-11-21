import { Router } from "express";
import { checkReadiness } from "../lib/health.js";

// explicit type so the declaration output doesn't reference pnpm internals
export const healthRouter: Router = Router();

// liveness: the process is up, no dependency checks so a db outage never restarts the container
healthRouter.get("/health/live", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// readiness: 200 when required dependencies are up, 503 otherwise
healthRouter.get("/health", async (_req, res) => {
  const body = await checkReadiness();
  res.status(body.status === "ok" ? 200 : 503).json(body);
});