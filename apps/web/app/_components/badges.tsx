import type { DeliveryStatus } from "@repo/shared/delivery";
import type { EndpointStatus } from "@repo/shared/webhook-endpoint";
import { endpointStatusLabel, endpointStatusTone, statusLabel, statusTone } from "../../lib/status";

// the label is always written out, so the badge never depends on its color

export function DeliveryBadge({ status, attemptCount }: { status: DeliveryStatus; attemptCount: number }) {
  return <span className={`badge badge-${statusTone(status)}`}>{statusLabel(status, attemptCount)}</span>;
}

export function EndpointBadge({ status }: { status: EndpointStatus }) {
  return <span className={`badge badge-${endpointStatusTone(status)}`}>{endpointStatusLabel(status)}</span>;
}
