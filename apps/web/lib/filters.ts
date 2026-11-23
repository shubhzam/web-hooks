import { deliveryStatusSchema, listDeliveriesQuerySchema, type DeliveryStatus } from "@repo/shared/delivery";

// what the url of the endpoint page carries
export interface DeliveryFilters {
  status: DeliveryStatus | undefined;
  eventType: string | undefined;
  cursor: string | undefined;
}

type RawParam = string | string[] | undefined;

function firstValue(value: RawParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// a value that does not pass the shared schema is dropped, so a hand edited url shows the
// unfiltered list instead of an error page
export function readFilters(params: Record<string, RawParam>): DeliveryFilters {
  const shape = listDeliveriesQuerySchema.shape;
  return {
    status: deliveryStatusSchema.safeParse(firstValue(params["status"])).data,
    eventType: shape.eventType.safeParse(firstValue(params["eventType"])).data,
    cursor: shape.cursor.safeParse(firstValue(params["cursor"])).data,
  };
}

export function readCursor(params: Record<string, RawParam>): string | undefined {
  return listDeliveriesQuerySchema.shape.cursor.safeParse(firstValue(params["cursor"])).data;
}
