import { createHash } from "node:crypto";

export function configurationRevisionToken(sessionId: string, revision: number | string): string {
  const decimal = typeof revision === "number" ? String(revision) : revision;
  if (!sessionId || !/^(0|[1-9][0-9]*)$/u.test(decimal) || !Number.isSafeInteger(Number(decimal)))
    throw new Error("Invalid durable Session configuration revision");
  return createHash("sha256")
    .update(JSON.stringify([sessionId, decimal]))
    .digest("hex");
}
