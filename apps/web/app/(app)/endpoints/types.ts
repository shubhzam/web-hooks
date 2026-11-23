export interface CreateFormValues {
  url: string;
  eventTypes: string;
  description: string;
}

export type CreateEndpointState =
  | { status: "idle" }
  | { status: "error"; errors: string[]; values: CreateFormValues }
  | { status: "created"; id: string; url: string; signingSecret: string };
