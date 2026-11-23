export type ReplayState = { status: "idle" } | { status: "replayed" } | { status: "error"; message: string };
