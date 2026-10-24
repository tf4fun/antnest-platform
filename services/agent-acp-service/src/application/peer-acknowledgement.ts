import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../domain/errors.js";
import { executionPublication } from "../domain/execution-publication.js";
import { parsePeerIdentityReceipt, parsePeerPublicationReceipt } from "../domain/peer-receipt.js";
import type { AgentOwnershipFence } from "../domain/agent-ownership.js";
import type { ExecutionConfiguration } from "../domain/execution-configuration.js";
import type { AgentPeers, PeerPublicationRequest } from "../ports/agent-peers.js";
import { PeerDeadlineError } from "../ports/agent-peers.js";
import type { LocalExecutionPublication } from "./execution-directory.js";
import { parseOwnerRegistration, type OwnerRegistration } from "./owner-incarnation.js";
import type { PeerAvailability } from "./peer-availability.js";
import type { PeerParticipationGuard } from "../ports/peer-participation.js";

export type PeerPublicationFailure = Readonly<{
  stage:
    | "availability_refresh"
    | "owned_prepare"
    | "availability"
    | "receipts"
    | "identity"
    | "apply"
    | "receipt"
    | "fence_union"
    | "publication_check"
    | "authority_confirm";
  revision: number;
  reason?: "missing" | "duplicate" | "unexpected";
  expectedOwners?: number;
  observedOwners?: number;
}>;

export type PeerAcknowledgementOptions = {
  reportFailure?: (diagnostic: PeerPublicationFailure, error: unknown) => void;
  registration: OwnerRegistration;
  membershipSha256: string;
  members: readonly string[];
  peers: AgentPeers;
  availability?: Pick<PeerAvailability, "refresh">;
  local: (
    capture: LocalExecutionPublication,
    request: PeerPublicationRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  confirm: (
    expected: ExecutionConfiguration,
    fences: readonly AgentOwnershipFence[],
    options: { timeoutMs: number; participation?: PeerParticipationGuard },
  ) => Promise<void>;
};

/** Collect readiness outside SQL/publication queues, then confirm the exact original authority. */
export class PeerAcknowledgement {
  private readonly registration: Readonly<OwnerRegistration>;
  private readonly membershipSha256: string;
  private readonly members: readonly string[];

  public constructor(private readonly options: PeerAcknowledgementOptions) {
    this.registration = parseOwnerRegistration(options.registration);
    if (
      !/^[0-9a-f]{64}$/u.test(options.membershipSha256) ||
      options.members.length < 1 ||
      options.members.length > 64 ||
      new Set(options.members).size !== options.members.length ||
      !options.members.includes(this.registration.member_id) ||
      options.members.some(
        (member) => member.length > 64 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(member),
      )
    )
      throw new Error("Invalid ACP peer membership");
    this.membershipSha256 = options.membershipSha256;
    this.members = Object.freeze([...options.members].sort());
  }

  public async confirm(
    capture: LocalExecutionPublication,
    deadline: Date,
    signal: AbortSignal,
  ): Promise<void> {
    const expiresAt = deadline.getTime();
    const remaining = expiresAt - Date.now();
    if (!Number.isSafeInteger(expiresAt) || remaining > 10000)
      throw new DomainError("invalid_request", "Invalid peer publication deadline");
    signal.throwIfAborted();
    if (remaining <= 0) throw expired();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(expired()), remaining);
    timer.unref();
    const lifetime = AbortSignal.any([signal, timeout.signal]);
    const requestId = randomUUID();
    const publication = executionPublication(capture.authority);
    const common = Object.freeze({
      request_id: requestId,
      deadline_at: deadline.toISOString(),
      membership_sha256: this.membershipSha256,
      source: this.registration,
    });
    const revision = capture.authority.revision;
    let diagnostic: PeerPublicationFailure = { stage: "availability", revision };
    try {
      const availability = await this.options.availability?.refresh(lifetime, expiresAt);
      if (
        availability !== undefined &&
        (availability.guard.membershipSha256 !== this.membershipSha256 ||
          availability.members.length !== this.members.length ||
          availability.members.some((member, index) => member.memberId !== this.members[index]))
      )
        throw unavailable();
      // allSettled owns every original operation. Cancellation must never make
      // an unjoined peer/database operation look like completed cleanup.
      diagnostic = { stage: "receipts", revision };
      const results = await Promise.allSettled(
        this.members.map(async (member) => {
          let memberStage: "identity" | "apply" | "receipt" = "identity";
          try {
            lifetime.throwIfAborted();
            const available = availability?.members.find((item) => item.memberId === member);
            // An exact stopped/never-participated result is kept distinct from a
            // live peer's joined revocation receipt. The final SQL guard covers both.
            if (available !== undefined && available.state !== "running") return null;
            let target = this.registration;
            if (member !== this.registration.member_id) {
              const challenge = randomBytes(32).toString("hex");
              const identity = parsePeerIdentityReceipt(
                await this.options.peers.identify(
                  member,
                  {
                    ...common,
                    target_member_id: member,
                    challenge,
                  },
                  lifetime,
                ),
              );
              lifetime.throwIfAborted();
              if (
                identity.request_id !== requestId ||
                identity.membership_sha256 !== this.membershipSha256 ||
                identity.challenge !== challenge ||
                identity.registration.member_id !== member
              )
                throw unavailable();
              target = parseOwnerRegistration(identity.registration);
            }
            if (
              available?.state === "running" &&
              !isDeepStrictEqual(target, available.registration)
            )
              throw unavailable();
            const request: PeerPublicationRequest = Object.freeze({
              ...common,
              target,
              publication,
              hop: 1,
            });
            memberStage = "apply";
            const raw =
              member === this.registration.member_id
                ? await this.options.local(capture, request, lifetime)
                : await this.options.peers.publish(member, request, lifetime);
            memberStage = "receipt";
            const receipt = parsePeerPublicationReceipt(raw);
            if (
              receipt.request_id !== requestId ||
              receipt.membership_sha256 !== this.membershipSha256 ||
              !isDeepStrictEqual(receipt.publication, publication) ||
              !isDeepStrictEqual(receipt.registration, target)
            )
              throw unavailable();
            return receipt;
          } catch (error) {
            this.reportFailure({ stage: memberStage, revision }, error);
            throw error;
          }
        }),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason as unknown);
      if (failures.length > 0) {
        const failure = unavailable();
        failure.cause = new AggregateError(failures, "Peer publication operations failed");
        throw failure;
      }
      lifetime.throwIfAborted();
      const accepting = new Set(
        capture.configuration.agents
          .filter((agent) => agent.accepting_runs)
          .map((agent) => agent.agent_id),
      );
      const fences = new Map<string, AgentOwnershipFence>();
      diagnostic = { stage: "fence_union", revision };
      const unionFailure = (reason: "missing" | "duplicate" | "unexpected") => {
        diagnostic = {
          stage: "fence_union",
          revision,
          reason,
          expectedOwners: accepting.size,
          observedOwners: fences.size,
        };
        return unavailable();
      };
      for (const result of results) {
        if (result.status !== "fulfilled") throw unavailable();
        const receipt = result.value;
        if (receipt === null) continue;
        for (const agent of receipt.owned_agents) {
          if (!accepting.has(agent.agent_id)) throw unionFailure("unexpected");
          if (fences.has(agent.agent_id)) throw unionFailure("duplicate");
          fences.set(
            agent.agent_id,
            Object.freeze({
              organizationId: capture.authority.organization_id,
              agentId: agent.agent_id,
              ownerInstanceId: receipt.registration.incarnation_id,
              epoch: agent.epoch,
            }),
          );
        }
      }
      if (fences.size !== accepting.size) throw unionFailure("missing");
      diagnostic = { stage: "publication_check", revision };
      capture.assertCurrent();
      const timeoutMs = expiresAt - Date.now();
      if (timeoutMs <= 0) throw expired();
      diagnostic = { stage: "authority_confirm", revision };
      await this.options.confirm(capture.authority, [...fences.values()], {
        timeoutMs,
        ...(availability === undefined ? {} : { participation: availability.guard }),
      });
      lifetime.throwIfAborted();
      if (Date.now() >= expiresAt) throw expired();
      diagnostic = { stage: "publication_check", revision };
      capture.assertCurrent();
    } catch (error) {
      this.reportFailure(diagnostic, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private reportFailure(diagnostic: PeerPublicationFailure, error: unknown): void {
    try {
      this.options.reportFailure?.(diagnostic, error);
    } catch {
      // Diagnostics never replace the original business or cleanup failure.
    }
  }
}

function unavailable(): DomainError {
  return new DomainError("configuration_unavailable", "Peer publication could not be confirmed");
}
function expired(): DomainError {
  const failure = unavailable();
  failure.cause = new PeerDeadlineError("Peer publication deadline exceeded");
  return failure;
}
