import type { DeliveryStatus } from "@repo/shared/delivery";
import type { EndpointStatus } from "@repo/shared/webhook-endpoint";

// the api speaks in internal states, the dashboard speaks in what a customer cares about.
// every badge carries its text, color is only a hint

export type Tone = "good" | "bad" | "wait" | "active" | "muted";

export function statusLabel(status: DeliveryStatus, attemptCount: number): string {
  switch (status) {
    case "succeeded":
      return "delivered";
    case "exhausted":
      return "failed";
    case "in_progress":
      return "sending";
    case "pending":
      return attemptCount > 0 ? "retrying" : "queued";
  }
}

export function statusTone(status: DeliveryStatus): Tone {
  switch (status) {
    case "succeeded":
      return "good";
    case "exhausted":
      return "bad";
    case "in_progress":
      return "active";
    case "pending":
      return "wait";
  }
}

// the filter has no attempt count to go on, so pending covers both queued and retrying
export const FILTER_OPTIONS: { value: DeliveryStatus; label: string }[] = [
  { value: "pending", label: "queued or retrying" },
  { value: "in_progress", label: "sending" },
  { value: "succeeded", label: "delivered" },
  { value: "exhausted", label: "failed" },
];

export function endpointStatusLabel(status: EndpointStatus): string {
  return status === "active" ? "enabled" : "disabled";
}

export function endpointStatusTone(status: EndpointStatus): Tone {
  return status === "active" ? "good" : "muted";
}
