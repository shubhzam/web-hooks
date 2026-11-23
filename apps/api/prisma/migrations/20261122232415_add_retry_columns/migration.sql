-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "cycle_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "replay_base" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "paused_until" TIMESTAMPTZ(3);
