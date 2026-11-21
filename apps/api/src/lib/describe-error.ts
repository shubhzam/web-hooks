// turns an error into a line that is safe to log. prisma error messages repeat the query
// arguments, which can hold a signing secret or an event payload, so for anything carrying a
// prisma clientVersion only the name and code are used
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  if ("clientVersion" in err) {
    const code = "code" in err ? String(err.code) : "no code";
    return `${err.name} ${code}`;
  }
  return err.message;
}
