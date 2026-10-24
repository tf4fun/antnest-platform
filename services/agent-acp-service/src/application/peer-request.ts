import { z } from "zod";
import { parseOwnerRegistration } from "./owner-incarnation.js";
import type { PeerIdentityRequest, PeerPublicationRequest } from "../ports/agent-peers.js";
import { DomainError } from "../domain/errors.js";
import { parseExecutionPublication } from "../domain/execution-publication.js";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const common = {
  request_id: uuid,
  deadline_at: z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
  membership_sha256: digest,
  source: z.unknown().transform(parseOwnerRegistration),
};
const identity = z.strictObject({
  ...common,
  target_member_id: z
    .string()
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  challenge: digest,
});
const publication = z.strictObject({
  ...common,
  target: z.unknown().transform(parseOwnerRegistration),
  publication: z.unknown().transform(parseExecutionPublication),
  hop: z.literal(1),
});

export function parsePeerIdentityRequest(value: unknown): PeerIdentityRequest {
  try {
    const parsed = identity.parse(value);
    peerDeadline(parsed.deadline_at);
    return Object.freeze(parsed);
  } catch {
    throw new DomainError("invalid_request", "Invalid peer identity request");
  }
}

export function parsePeerPublicationRequest(value: unknown): PeerPublicationRequest {
  try {
    const parsed = publication.parse(value);
    peerDeadline(parsed.deadline_at);
    return Object.freeze(parsed);
  } catch {
    throw new DomainError("invalid_request", "Invalid peer publication request");
  }
}

/** Validate calendar semantics as well as wire shape; do not reset this deadline per hop. */
export function peerDeadline(value: string): number {
  const deadline = Date.parse(value);
  if (
    !Number.isFinite(deadline) ||
    new Date(deadline).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new DomainError("invalid_request", "Invalid peer deadline");
  return deadline;
}
