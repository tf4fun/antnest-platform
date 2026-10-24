import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AgentAssignment } from "../../src/application/agent-assignment.js";
import type { ExecutionDirectory } from "../../src/application/execution-directory.js";
import { OwnerForwarding } from "../../src/application/owner-forwarding.js";
import { controlBodyDigest } from "../../src/application/owner-control-forwarding.js";
import { executionPublication } from "../../src/domain/execution-publication.js";
import type { AgentSettlementRequest } from "../../src/domain/agent-settlement.js";
import type { PeerIdentityRequest } from "../../src/ports/agent-peers.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

afterEach(() => vi.useRealTimers());

function setup() {
  const registration = (member_id: string) => ({
    member_id,
    registration_id: randomUUID(),
    incarnation_id: randomUUID(),
  });
  const a = registration("acp-a"),
    b = registration("acp-b");
  const assignment = new AgentAssignment(a.member_id, [a.member_id, b.member_id]);
  const authority = executionConfiguration();
  const scope = { organizationId: authority.organization_id, agentId: "agent-1" };
  for (let i = 1; assignment.preferred(scope) !== b.member_id; i++) scope.agentId = `agent-${i}`;
  const closedAgent = vi.fn(() => ({
    revision: authority.revision,
    agent: { accepting_runs: false },
  }));
  const assertCurrent = vi.fn();
  const inspect = vi.fn(() => {
    throw new Error("Settlement must not require user execution admission");
  });
  const directory = {
    closedAgent,
    inspect,
    capturePublication: vi.fn(() => ({ authority, assertCurrent })),
  } as unknown as ExecutionDirectory;
  const read = vi.fn(() => {
    throw new Error("Settlement must not require a live execution lease");
  });
  const identify = vi.fn((_member: string, request: PeerIdentityRequest) =>
    Promise.resolve({
      request_id: request.request_id,
      membership_sha256: request.membership_sha256,
      challenge: request.challenge,
      registration: b,
    }),
  );
  const resolver = new OwnerForwarding({
    registration: a,
    membershipSha256: "a".repeat(64),
    assignment,
    directory,
    leases: { read },
    peers: { identify },
  });
  const input: AgentSettlementRequest = {
    organization_id: scope.organizationId,
    agent_id: scope.agentId,
    minimum_revision: authority.revision,
    operation_id: "operation-closed",
    mode: "cancel",
    deadline_at: new Date(Date.now() + 5000).toISOString(),
  };
  return {
    resolver,
    input,
    scope,
    a,
    b,
    authority,
    assignment,
    closedAgent,
    assertCurrent,
    inspect,
    read,
    identify,
  };
}

it("discovers the fixed closed-Agent owner without user admission or any live lease", async () => {
  const f = setup();
  const result = await f.resolver.resolveSettlement(f.input, new AbortController().signal);
  expect(result).toMatchObject({
    operation: "settlement",
    caller: "agent-controller",
    scope: f.scope,
    source: f.a,
    target: f.b,
    publication: executionPublication(f.authority),
    body_sha256: controlBodyDigest(f.input),
    deadline_at: f.input.deadline_at,
    hop: 1,
  });
  expect(result).not.toHaveProperty("identity");
  expect(result).not.toHaveProperty("epoch");
  expect(f.closedAgent).toHaveBeenCalledWith({
    ...f.scope,
    operationId: f.input.operation_id,
    minimumRevision: f.input.minimum_revision,
  });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.inspect).not.toHaveBeenCalled();
});

it("keeps local settlement local while still validating its closed operation", async () => {
  const f = setup();
  for (let i = 1; f.assignment.preferred(f.scope) !== f.a.member_id; i++)
    f.scope.agentId = `agent-${i}`;
  f.input.agent_id = f.scope.agentId;
  expect(await f.resolver.resolveSettlement(f.input, new AbortController().signal)).toBeNull();
  expect(f.closedAgent).toHaveBeenCalled();
  expect(f.identify).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it("retains the original operation deadline while bounding member discovery to ten seconds", async () => {
  vi.useFakeTimers();
  const f = setup();
  f.input.deadline_at = new Date(Date.now() + 60000).toISOString();
  const started = Date.now();
  const result = await f.resolver.resolveSettlement(f.input, new AbortController().signal);
  expect(result?.deadline_at).toBe(f.input.deadline_at);
  expect(Date.parse(f.identify.mock.calls[0]![1].deadline_at)).toBe(started + 10000);
});

it("returns an expired operation to local settlement without remote dispatch after late discovery", async () => {
  vi.useFakeTimers();
  const f = setup();
  const original = f.identify.getMockImplementation()!;
  f.identify.mockImplementation(async (member, request) => {
    const receipt = await original(member, request);
    vi.setSystemTime(new Date(f.input.deadline_at));
    return receipt;
  });
  await expect(
    f.resolver.resolveSettlement(f.input, new AbortController().signal),
  ).resolves.toBeNull();
  expect(f.read).not.toHaveBeenCalled();
});

it("lets the original settlement return not_settled for an already expired closed operation", async () => {
  const f = setup();
  f.input.deadline_at = new Date(Date.now() - 1).toISOString();
  await expect(
    f.resolver.resolveSettlement(f.input, new AbortController().signal),
  ).resolves.toBeNull();
  expect(f.closedAgent).toHaveBeenCalled();
  expect(f.identify).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it("does not adopt a changed publication or a foreign member receipt", async () => {
  const f = setup();
  f.assertCurrent.mockImplementation(() => {
    throw new Error("Publication changed");
  });
  await expect(f.resolver.resolveSettlement(f.input, new AbortController().signal)).rejects.toThrow(
    "Publication changed",
  );
  f.assertCurrent.mockReset();
  const original = f.identify.getMockImplementation()!;
  f.identify.mockImplementation(async (member, request) => ({
    ...(await original(member, request)),
    registration: f.a,
  }));
  await expect(
    f.resolver.resolveSettlement(f.input, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
});
