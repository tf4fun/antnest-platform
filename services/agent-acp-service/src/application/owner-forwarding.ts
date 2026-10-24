import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { strictObject } from "../adapters/strict-json.js";
import { ownershipFence } from "../domain/agent-ownership.js";
import { DomainError } from "../domain/errors.js";
import {
  executionPublication,
  parseExecutionPublication,
} from "../domain/execution-publication.js";
import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import type { AgentSettlementRequest } from "../domain/agent-settlement.js";
import { parsePeerIdentityReceipt } from "../domain/peer-receipt.js";
import type { AgentLeases } from "../ports/agent-leases.js";
import type { AgentPeers } from "../ports/agent-peers.js";
import { PeerDeadlineError } from "../ports/agent-peers.js";
import type { AgentAssignment } from "./agent-assignment.js";
import type { PeerAvailabilityCapture } from "./peer-availability.js";
import type { ExecutionDirectory } from "./execution-directory.js";
import { parseOwnerRegistration, type OwnerRegistration } from "./owner-incarnation.js";
import { peerDeadline } from "./peer-request.js";
import { controlBodyDigest, type OwnerControlRequest } from "./owner-control-forwarding.js";

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
export type OwnerExecutionAdmission = Pick<
  OwnerForwardRequest,
  "identity" | "target" | "epoch" | "publication" | "deadline_at"
>;

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
      availability?: () => PeerAvailabilityCapture;
      directory: ExecutionDirectory;
      leases: Pick<AgentLeases, "read">;
      peers: Pick<AgentPeers, "identify">;
    },
  ) {}

  public async resolveSettlement(
    input: AgentSettlementRequest,
    signal: AbortSignal,
  ): Promise<Extract<OwnerControlRequest, { operation: "settlement" }> | null> {
    const { directory, assignment, registration, membershipSha256 } = this.options;
    const scope = { organizationId: input.organization_id, agentId: input.agent_id };
    const operation = {
      ...scope,
      operationId: input.operation_id,
      minimumRevision: input.minimum_revision,
    };
    signal.throwIfAborted();
    directory.closedAgent(operation);
    const operationDeadline = peerDeadline(input.deadline_at);
    // The existing local service validates the closed operation and returns
    // not_settled without acquiring a lease once the business deadline expires.
    if (Date.now() >= operationDeadline) return null;
    const publication = directory.capturePublication(scope.organizationId);
    const deadline = Math.min(operationDeadline, Date.now() + 10000);
    const view = this.options.availability?.();
    let expected: OwnerRegistration | undefined;
    let member = assignment.preferred(scope);
    if (view !== undefined) {
      const readStarted = performance.now();
      const lease = await this.options.leases.read(scope);
      signal.throwIfAborted();
      publication.assertCurrent();
      directory.closedAgent(operation);
      if (Date.now() >= operationDeadline) return null;
      if (Date.now() >= deadline) throw new PeerDeadlineError("Settlement owner discovery expired");
      if (
        lease !== null &&
        lease.expiresAt.getTime() - lease.observedAt.getTime() > performance.now() - readStarted
      ) {
        expected = view.live.find(
          (original) => original.incarnation_id === lease.fence.ownerInstanceId,
        );
        if (expected === undefined) throw unavailable();
        member = expected.member_id;
      } else {
        member = assignment.target(scope);
        expected = view.live.find((original) => original.member_id === member);
        if (expected === undefined) throw unavailable();
      }
    }
    if (member === registration.member_id) {
      if (expected !== undefined && !isDeepStrictEqual(expected, registration)) throw unavailable();
      return null;
    }
    if (Date.now() >= deadline) throw new PeerDeadlineError("Settlement owner discovery expired");
    const discovery = {
      request_id: randomUUID(),
      deadline_at: new Date(deadline).toISOString(),
      membership_sha256: membershipSha256,
      source: registration,
      target_member_id: member,
      challenge: randomBytes(32).toString("hex"),
    };
    const receipt = parsePeerIdentityReceipt(
      await this.options.peers.identify(member, discovery, signal),
    );
    signal.throwIfAborted();
    if (
      receipt.request_id !== discovery.request_id ||
      receipt.challenge !== discovery.challenge ||
      receipt.membership_sha256 !== membershipSha256 ||
      receipt.registration.member_id !== member ||
      (expected !== undefined && !isDeepStrictEqual(receipt.registration, expected))
    )
      throw unavailable();
    publication.assertCurrent();
    directory.closedAgent(operation);
    if (Date.now() >= operationDeadline) return null;
    if (Date.now() >= deadline) throw new PeerDeadlineError("Settlement owner discovery expired");
    return Object.freeze({
      operation: "settlement",
      caller: "agent-controller",
      scope: Object.freeze(scope),
      request_id: discovery.request_id,
      deadline_at: input.deadline_at,
      membership_sha256: membershipSha256,
      source: registration,
      target: receipt.registration,
      publication: executionPublication(publication.authority),
      body_sha256: controlBodyDigest(input),
      hop: 1,
    });
  }

  public async resolve(
    identity: ExecutionIdentity,
    protocol: "v1" | "v2",
    signal: AbortSignal,
    includeLocal = false,
    originalDeadline?: number,
  ): Promise<OwnerForwardRequest | null> {
    const { directory, assignment, registration, membershipSha256 } = this.options;
    signal.throwIfAborted();
    directory.inspect(identity);
    const deadline = Math.min(Date.now() + 10000, originalDeadline ?? Infinity);
    if (Date.now() >= deadline) throw new PeerDeadlineError("Owner resolution expired");
    const view = this.options.availability?.();
    // Keep the legacy local fast path for non-peer component callers. Production
    // peer ingress always captures the real lease before choosing a destination.
    if (
      view === undefined &&
      assignment.preferred(identity) === registration.member_id &&
      !includeLocal
    )
      return null;
    const publication = directory.capturePublication(identity.organizationId);
    const readStarted = performance.now();
    const capturedLease = view === undefined ? undefined : await this.options.leases.read(identity);
    let expected: OwnerRegistration | undefined;
    let member = assignment.preferred(identity);
    if (view !== undefined) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new PeerDeadlineError("Owner resolution expired");
      if (
        capturedLease == null ||
        capturedLease.expiresAt.getTime() - capturedLease.observedAt.getTime() <=
          performance.now() - readStarted
      )
        throw unavailable();
      expected = view.live.find(
        (original) => original.incarnation_id === capturedLease.fence.ownerInstanceId,
      );
      if (expected === undefined) throw unavailable();
      member = expected.member_id;
      publication.assertCurrent();
      directory.inspect(identity);
      if (member === registration.member_id && !isDeepStrictEqual(expected, registration))
        throw unavailable();
      if (member === registration.member_id && !includeLocal) return null;
    }
    const requestId = randomUUID();
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
      receipt.registration.member_id !== member ||
      (expected !== undefined && !isDeepStrictEqual(receipt.registration, expected))
    )
      throw unavailable();
    const lease = capturedLease ?? (await this.options.leases.read(identity));
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

  /** Source batches share one original budget and bind local groups as well. */
  public async resolveSource(
    identity: ExecutionIdentity,
    deadline: number,
    signal: AbortSignal,
  ): Promise<OwnerForwardRequest> {
    const result = await this.resolve(identity, "v1", signal, true, deadline);
    if (result === null) throw unavailable();
    return result;
  }
}
function unavailable(): DomainError {
  return new DomainError("agent_unavailable", "Agent owner is unavailable");
}
