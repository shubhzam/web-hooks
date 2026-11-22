-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "completed_at" TIMESTAMPTZ(3),
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_ms" INTEGER,
    "response_status" INTEGER,
    "error" TEXT,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_delivery_id_attempt_number_key" ON "delivery_attempts"("delivery_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- hand written, prisma cannot declare partial indexes
-- the reaper looks only at deliveries a worker is holding, ordered by when the lease ran out
CREATE INDEX "deliveries_in_progress_lease_idx" ON "deliveries"("lease_expires_at") WHERE "status" = 'in_progress';
