-- CreateIndex
CREATE INDEX "deliveries_organization_id_id_idx" ON "deliveries"("organization_id", "id");

-- CreateIndex
CREATE INDEX "deliveries_endpoint_id_id_idx" ON "deliveries"("endpoint_id", "id");
