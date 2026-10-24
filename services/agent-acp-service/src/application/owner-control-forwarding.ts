import { createHash } from "node:crypto";
import { z } from "zod";
import { strictObject } from "../adapters/strict-json.js";
import { ownershipFence } from "../domain/agent-ownership.js";
import { DomainError } from "../domain/errors.js";
import { parseExecutionPublication } from "../domain/execution-publication.js";
import { parseOwnerRegistration } from "./owner-incarnation.js";
import { peerDeadline } from "./peer-request.js";

const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const scope = z.strictObject({ organizationId: identifier, agentId: identifier });
const identity = scope.extend({ principalId: identifier });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const common = {
  request_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  deadline_at: z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
  membership_sha256: digest,
  source: z.unknown().transform(parseOwnerRegistration),
  target: z.unknown().transform(parseOwnerRegistration),
  publication: z.unknown().transform(parseExecutionPublication),
  body_sha256: digest,
  hop: z.literal(1),
};
const execution = { ...common, identity, epoch: z.string() };
const schema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...execution,
    operation: z.literal("state-read"),
    caller: z.literal("agent-ui"),
  }),
  z.strictObject({
    ...execution,
    operation: z.literal("state-watch"),
    caller: z.literal("agent-ui"),
  }),
  z.strictObject({
    ...execution,
    operation: z.literal("source-inspect"),
    caller: z.literal("skill-registry"),
  }),
  z.strictObject({
    ...execution,
    operation: z.literal("source-artifact"),
    caller: z.literal("skill-registry"),
  }),
  z.strictObject({
    ...common,
    operation: z.literal("settlement"),
    caller: z.literal("agent-controller"),
    scope,
  }),
]);
export type OwnerControlRequest = Readonly<z.infer<typeof schema>>;

function parse(value: unknown): OwnerControlRequest {
  const result = schema.parse(value);
  peerDeadline(result.deadline_at);
  const scope = result.operation === "settlement" ? result.scope : result.identity;
  if (scope.organizationId !== result.publication.organization_id)
    throw new Error("Control scope mismatch");
  if (result.operation !== "settlement") {
    ownershipFence({
      ...scope,
      ownerInstanceId: result.target.incarnation_id,
      epoch: result.epoch,
    });
    Object.freeze(result.identity);
  } else Object.freeze(result.scope);
  return Object.freeze(result);
}

export function controlBodyDigest(validated: unknown): string {
  return createHash("sha256").update(JSON.stringify(validated)).digest("hex");
}

export function encodeOwnerControl(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(parse(value))).toString("base64url");
  if (encoded.length > 16384)
    throw new DomainError("invalid_request", "Owner control context is too large");
  return encoded;
}

export function parseOwnerControl(value: string): OwnerControlRequest {
  try {
    if (value.length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    return parse(strictObject(bytes));
  } catch {
    throw new DomainError("invalid_request", "Invalid owner control context");
  }
}
