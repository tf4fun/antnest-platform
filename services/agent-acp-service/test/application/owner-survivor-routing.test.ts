import { describe, expect, it, vi } from "vitest";
import { AgentAssignment } from "../../src/application/agent-assignment.js";
import type { ExecutionDirectory } from "../../src/application/execution-directory.js";
import { OwnerForwarding } from "../../src/application/owner-forwarding.js";
import type { OwnerRegistration } from "../../src/application/owner-incarnation.js";
import type { PeerAvailabilityCapture } from "../../src/application/peer-availability.js";
import { ownershipFence } from "../../src/domain/agent-ownership.js";
import type { AgentSettlementRequest } from "../../src/domain/agent-settlement.js";
import { executionPublication } from "../../src/domain/execution-publication.js";
import type { AgentLeases } from "../../src/ports/agent-leases.js";
import type { AgentPeers } from "../../src/ports/agent-peers.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

const membershipSha256 = "a".repeat(64);
const members = ["acp-a", "acp-b"];
const registration = (member_id: string, digit: string): OwnerRegistration =>
  Object.freeze({
    member_id,
    registration_id: `${digit.repeat(8)}-1111-4111-8111-111111111111`,
    incarnation_id: `${digit.repeat(8)}-2222-4222-8222-222222222222`,
  });
const a = registration("acp-a", "1");
const stoppedB = registration("acp-b", "2");
const rejoinedB = registration("acp-b", "3");
const replacementA = registration("acp-a", "4");

function stopped(original: OwnerRegistration) {
  return Object.freeze({
    ...original,
    state: "stopped" as const,
    stop_receipt: Object.freeze({
      receipt_id: `${original.registration_id.slice(0, 8)}-3333-4333-8333-333333333333`,
      reason: "container_stopped" as const,
      observed_at: "2026-10-24T00:00:00.000Z",
    }),
  });
}

function capture(bRunning = false, aReplaced = false): PeerAvailabilityCapture {
  const currentA = aReplaced ? replacementA : a;
  return Object.freeze({
    guard: Object.freeze({
      membershipSha256,
      revision: String(2 + Number(bRunning) + Number(aReplaced)),
    }),
    members: Object.freeze([
      Object.freeze({
        memberId: a.member_id,
        state: "running" as const,
        registration: currentA,
        stopped: Object.freeze(aReplaced ? [stopped(a)] : []),
      }),
      bRunning
        ? Object.freeze({
            memberId: stoppedB.member_id,
            state: "running" as const,
            registration: rejoinedB,
            stopped: Object.freeze([stopped(stoppedB)]),
          })
        : Object.freeze({
            memberId: stoppedB.member_id,
            state: "stopped" as const,
            stopped: Object.freeze([stopped(stoppedB)]),
          }),
    ]),
    live: Object.freeze(bRunning ? [currentA, rejoinedB] : [currentA]),
  });
}

function setup(local: OwnerRegistration, view: PeerAvailabilityCapture) {
  const availability = vi.fn(() => view);
  const assignment = new AgentAssignment(local.member_id, members, availability);
  const authority = executionConfiguration();
  const identity = {
    organizationId: authority.organization_id,
    principalId: "principal-1",
    agentId: "agent-1",
  };
  for (let index = 1; assignment.preferred(identity) !== stoppedB.member_id; index++)
    identity.agentId = `agent-${index}`;
  authority.agents[0]!.agent_id = identity.agentId;
  const assertCurrent = vi.fn();
  const inspect = vi.fn();
  const closedAgent = vi.fn(() => ({
    revision: authority.revision,
    agent: { accepting_runs: false },
  }));
  const directory = {
    inspect,
    closedAgent,
    capturePublication: vi.fn(() => ({ authority, assertCurrent })),
  } as unknown as ExecutionDirectory;
  const fence = ownershipFence({ ...identity, ownerInstanceId: a.incarnation_id, epoch: "7" });
  const observedAt = new Date();
  const read = vi.fn<AgentLeases["read"]>(() =>
    Promise.resolve({
      fence,
      observedAt,
      expiresAt: new Date(observedAt.getTime() + 60000),
    }),
  );
  const identify = vi.fn<AgentPeers["identify"]>((member, request) => {
    const target = view.live.find((original) => original.member_id === member);
    if (target === undefined) return Promise.reject(new Error("Stopped member was contacted"));
    return Promise.resolve({
      request_id: request.request_id,
      membership_sha256: request.membership_sha256,
      challenge: request.challenge,
      registration: target,
    });
  });
  const resolver = new OwnerForwarding({
    registration: local,
    membershipSha256,
    assignment,
    availability,
    directory,
    leases: { read },
    peers: { identify },
  });
  return {
    resolver,
    assignment,
    identity,
    authority,
    fence,
    read,
    identify,
    inspect,
    closedAgent,
    assertCurrent,
    availability,
  };
}

describe("survivor routing follows the actual live lease owner", () => {
  it("keeps A execution local after the preferred B has stopped", async () => {
    const f = setup(a, capture());
    expect(f.assignment.preferred(f.identity)).toBe(stoppedB.member_id);
    expect(f.assignment.target(f.identity)).toBe(a.member_id);

    await expect(
      f.resolver.resolve(f.identity, "v1", new AbortController().signal),
    ).resolves.toBeNull();

    expect(f.read).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledWith(f.identity);
    expect(f.inspect).toHaveBeenCalledWith(f.identity);
    expect(f.identify).not.toHaveBeenCalled();
  });

  it("forwards the rejoined B entry to A without moving A's live lease back to B", async () => {
    const f = setup(rejoinedB, capture(true));
    expect(f.assignment.preferred(f.identity)).toBe(rejoinedB.member_id);
    expect(f.assignment.target(f.identity)).toBe(rejoinedB.member_id);

    const result = await f.resolver.resolve(f.identity, "v2", new AbortController().signal);

    expect(result).toMatchObject({
      source: rejoinedB,
      target: a,
      epoch: f.fence.epoch,
      identity: f.identity,
      publication: executionPublication(f.authority),
      membership_sha256: membershipSha256,
      protocol: "v2",
      caller: "agent-ui",
      hop: 1,
    });
    expect(f.read).toHaveBeenCalledWith(f.identity);
    expect(f.identify).toHaveBeenCalledOnce();
    expect(f.identify.mock.calls[0]![0]).toBe(a.member_id);
    expect(f.identify.mock.calls[0]![1]).toMatchObject({
      source: rejoinedB,
      target_member_id: a.member_id,
      membership_sha256: membershipSha256,
    });
    expect(f.assertCurrent).toHaveBeenCalled();
  });

  it("rejects a lease whose original incarnation is absent from live participation", async () => {
    const f = setup(rejoinedB, capture(true, true));
    expect(f.assignment.target(f.identity)).toBe(rejoinedB.member_id);

    await expect(
      f.resolver.resolve(f.identity, "v1", new AbortController().signal),
    ).rejects.toMatchObject({ code: "agent_unavailable" });

    expect(f.read).toHaveBeenCalledWith(f.identity);
    expect(f.identify).not.toHaveBeenCalled();
  });

  it("settles the closed partition on surviving A without requiring a live lease", async () => {
    const f = setup(a, capture());
    f.read.mockResolvedValue(null);
    const input: AgentSettlementRequest = {
      organization_id: f.identity.organizationId,
      agent_id: f.identity.agentId,
      minimum_revision: f.authority.revision,
      operation_id: "operation-closed",
      mode: "cancel",
      deadline_at: new Date(Date.now() + 60000).toISOString(),
    };
    expect(f.assignment.preferred(f.identity)).toBe(stoppedB.member_id);
    expect(f.assignment.target(f.identity)).toBe(a.member_id);

    await expect(
      f.resolver.resolveSettlement(input, new AbortController().signal),
    ).resolves.toBeNull();

    expect(f.closedAgent).toHaveBeenCalledWith({
      organizationId: input.organization_id,
      agentId: input.agent_id,
      operationId: input.operation_id,
      minimumRevision: input.minimum_revision,
    });
    expect(f.read).toHaveBeenCalledWith({
      organizationId: input.organization_id,
      agentId: input.agent_id,
    });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.identify).not.toHaveBeenCalled();
  });
});
