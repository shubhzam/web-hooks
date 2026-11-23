"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { createWebhookEndpointSchema, endpointStatusSchema } from "@repo/shared/webhook-endpoint";
import { ApiError, ApiUnavailableError, createEndpoint, deleteEndpoint, updateEndpoint } from "../../../lib/api";
import type { CreateEndpointState, CreateFormValues } from "./types";

function readValues(formData: FormData): CreateFormValues {
  const text = (name: string) => {
    const raw = formData.get(name);
    return typeof raw === "string" ? raw : "";
  };
  return { url: text("url").trim(), eventTypes: text("eventTypes"), description: text("description").trim() };
}

// one event type per line, blank lines do not count
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function failed(values: CreateFormValues, errors: string[]): CreateEndpointState {
  return { status: "error", errors, values };
}

function apiProblem(err: unknown): string[] {
  if (err instanceof ApiError && err.code === "endpoint_url_exists") return ["an endpoint with this url already exists"];
  if (err instanceof ApiError && err.details.length > 0) return err.details;
  if (err instanceof ApiError && err.apiMessage !== null) return [err.apiMessage];
  if (err instanceof ApiUnavailableError) return ["the api is not reachable, try again in a moment"];
  return ["the endpoint could not be created"];
}

// the signing secret travels back in the action state and nowhere else. it is not logged, not put
// in a url or a cookie, and the page that shows it keeps it in memory only
export async function createEndpointAction(_previous: CreateEndpointState, formData: FormData): Promise<CreateEndpointState> {
  const values = readValues(formData);
  const parsed = createWebhookEndpointSchema.safeParse({
    url: values.url,
    eventTypes: splitLines(values.eventTypes),
    ...(values.description === "" ? {} : { description: values.description }),
  });
  if (!parsed.success) {
    return failed(
      values,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`),
    );
  }
  try {
    const created = await createEndpoint(parsed.data);
    revalidatePath("/endpoints");
    return { status: "created", id: created.id, url: created.url, signingSecret: created.signingSecret };
  } catch (err) {
    unstable_rethrow(err);
    return failed(values, apiProblem(err));
  }
}

function readField(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

export async function setEndpointStatusAction(formData: FormData): Promise<void> {
  const status = endpointStatusSchema.parse(readField(formData, "status"));
  await updateEndpoint(readField(formData, "id"), { status });
  revalidatePath("/endpoints");
  revalidatePath(`/endpoints/${readField(formData, "id")}`);
}

export async function deleteEndpointAction(formData: FormData): Promise<void> {
  await deleteEndpoint(readField(formData, "id"));
  revalidatePath("/endpoints");
  redirect("/endpoints");
}
