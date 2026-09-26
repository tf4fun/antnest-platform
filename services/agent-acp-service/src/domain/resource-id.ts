import { createHash, randomBytes } from "node:crypto";

export const resourceKinds = [
  "session",
  "run",
  "message",
  "mcprev",
  "checkpoint",
  "toolattempt",
  "request",
] as const;

export type ResourceKind = (typeof resourceKinds)[number];
export type ResourceIdGenerator = (kind: ResourceKind) => string;

export const newResourceId: ResourceIdGenerator = (kind) =>
  `${kind}_${randomBytes(16).toString("hex")}`;

export function deriveResourceId(kind: ResourceKind, namespace: string, key: string): string {
  const suffix = createHash("sha256").update(`${namespace}\0${key}`).digest("hex").slice(0, 32);
  return `${kind}_${suffix}`;
}
