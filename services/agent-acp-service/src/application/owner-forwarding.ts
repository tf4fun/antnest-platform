import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { strictObject } from "../adapters/strict-json.js";
import { ownershipFence } from "../domain/agent-ownership.js";
import { DomainError } from "../domain/errors.js";
import {
  executionPublication,
  parseExecutionPublication,
} from "../domain/execution-publication.js";
import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import { parsePeerIdentityReceipt } from "../domain/peer-receipt.js";
import type { AgentLeases } from "../ports/agent-leases.js";
import type { AgentPeers } from "../ports/agent-peers.js";
import { PeerDeadlineError } from "../ports/agent-peers.js";
import type { AgentAssignment } from "./agent-assignment.js";
import type { ExecutionDirectory } from "./execution-directory.js";
import { parseOwnerRegistration, type OwnerRegistration } from "./owner-incarnation.js";
import { peerDeadline } from "./peer-request.js";

export const OWNER_FORWARD_HEADER = "Antnest-ACP-Forward";
export const OWNER_FORWARD_PATH = "/internal/acp-peer/forward/ws";
const identityValue = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const schema = z.strictObject({
  request_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  deadline_at: z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
  membership_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.unknown().transform(parseOwnerRegistration),
  target: z.unknown().transform(parseOwnerRegistration),
  publication: z.unknown().transform(parseExecutionPublication),
  identity: z.strictObject({
    organizationId: identityValue,
    principalId: identityValue,
    agentId: identityValue,
  }),
  epoch: z.string(),
  protocol: z.enum(["v1", "v2"]),
  caller: z.literal("agent-ui"),
  hop: z.literal(1),
});
export type OwnerForwardRequest = Readonly<z.infer<typeof schema>>;

function parse(value: unknown): OwnerForwardRequest {
  const result = schema.parse(value);
  peerDeadline(result.deadline_at);
  ownershipFence({
    ...result.identity,
    ownerInstanceId: result.target.incarnation_id,
    epoch: result.epoch,
  });
  if (result.identity.organizationId !== result.publication.organization_id)
    throw new Error("Forwarding scope mismatch");
  Object.freeze(result.identity);
  return Object.freeze(result);
}
export function encodeOwnerForward(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(parse(value))).toString("base64url");
  if (encoded.length > 16384)
    throw new DomainError("invalid_request", "Forwarding header too large");
  return encoded;
}
export function parseOwnerForward(value: string): OwnerForwardRequest {
  try {
    if (value.length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    return parse(strictObject(bytes));
  } catch {
    throw new DomainError("invalid_request", "Invalid owner forwarding context");
  }
}

/** Discovery is read-only. Only the receiving generation can authorize execution. */
export class OwnerForwarding {
  public constructor(
    private readonly options: {
      registration: OwnerRegistration;
      membershipSha256: string;
      assignment: AgentAssignment;
      directory: ExecutionDirectory;
      leases: Pick<AgentLeases, "read">;
      peers: Pick<AgentPeers, "identify">;
    },
  ) {}

  public async resolve(
    identity: ExecutionIdentity,
    protocol: "v1" | "v2",
    signal: AbortSignal,
    includeLocal = false,
  ): Promise<OwnerForwardRequest | null> {
    const { directory, assignment, registration, membershipSha256 } = this.options;
    directory.inspect(identity);
    const member = assignment.preferred(identity);
    if (member === registration.member_id && !includeLocal) return null;
    const publication = directory.capturePublication(identity.organizationId);
    const requestId = randomUUID();
    const deadline = Date.now() + 10000;
    const challenge = randomBytes(32).toString("hex");
    const discovery = {
      request_id: requestId,
      deadline_at: new Date(deadline).toISOString(),
      membership_sha256: membershipSha256,
      source: registration,
      target_member_id: member,
      challenge,
    };
    const receipt =
      member === registration.member_id
        ? { ...discovery, registration }
        : parsePeerIdentityReceipt(await this.options.peers.identify(member, discovery, signal));
    signal.throwIfAborted();
    if (
      receipt.request_id !== requestId ||
      receipt.challenge !== challenge ||
      receipt.membership_sha256 !== membershipSha256 ||
      receipt.registration.member_id !== member
    )
      throw unavailable();
    const lease = await this.options.leases.read(identity);
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new PeerDeadlineError("Owner resolution expired");
    if (
      lease === null ||
      lease.expiresAt.getTime() <= lease.observedAt.getTime() ||
      lease.fence.ownerInstanceId !== receipt.registration.incarnation_id
    )
      throw unavailable();
    publication.assertCurrent();
    directory.inspect(identity);
    return parse({
      request_id: requestId,
      deadline_at: discovery.deadline_at,
      membership_sha256: membershipSha256,
      source: registration,
      target: receipt.registration,
      publication: executionPublication(publication.authority),
      identity,
      epoch: lease.fence.epoch,
      protocol,
      caller: "agent-ui",
      hop: 1,
    });
  }
}
function unavailable(): DomainError {
  return new DomainError("agent_unavailable", "Agent owner is unavailable");
}
