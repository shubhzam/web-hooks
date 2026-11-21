import { Redis } from "ioredis";
import { config } from "../config.js";

// no offline queue, so commands fail right away when redis is down instead of hanging
export const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

// without a listener ioredis prints an unhandled error event on every reconnect attempt
redis.on("error", (err) => {
  console.error(`redis error: ${err.message}`);
});