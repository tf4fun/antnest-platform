import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentAssignment } from "../../src/application/agent-assignment.js";
import type { PeerAvailabilityCapture } from "../../src/application/peer-availability.js";
import { AgentOwnershipLostError } from "../../src/domain/agent-ownership.js";

type Vector = {
  organization_id: string;
  agent_id: string;
  members: string[];
  preferred_member: string;
};
const contract = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/agent-acp/owner-assignment-contract.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };

describe("fixed complete-membership Agent assignment", () => {
  it.each(contract.vectors)(
    "uses the canonical complete digest for $organization_id / $agent_id",
    (v) => {
      for (const member of v.members) {
        const assignment = new AgentAssignment(member, [...v.members].reverse());
        expect(
          assignment.preferred({ organizationId: v.organization_id, agentId: v.agent_id }),
        ).toBe(v.preferred_member);
        expect(assignment.owns({ organizationId: v.organization_id, agentId: v.agent_id })).toBe(
          member === v.preferred_member,
        );
      }
    },
  );
  it("captures the complete catalog before callers can change it", () => {
    const v = contract.vectors[0]!;
    const members = [...v.members];
    const assignment = new AgentAssignment(v.preferred_member, members);
    members.splice(0, members.length, "replacement");
    expect(assignment.preferred({ organizationId: v.organization_id, agentId: v.agent_id })).toBe(
      v.preferred_member,
    );
  });
  it("retains the one-member behavior and keeps organization in the partition key", () => {
    expect(
      new AgentAssignment("acp-a", ["acp-a"]).owns({ organizationId: "o", agentId: "a" }),
    ).toBe(true);
    const assignment = new AgentAssignment("acp-a", ["acp-a", "acp-b", "acp-c"]);
    expect(assignment.preferred({ organizationId: "org-1", agentId: "agent-1" })).not.toBe(
      assignment.preferred({ organizationId: "org-2", agentId: "agent-1" }),
    );
  });
  it.each([
    [],
    ["acp-a", "acp-a"],
    ["acp-a\n"],
    ["ACP-A"],
    ["unknown"],
    Array.from({ length: 65 }, (_, i) => `acp-${i}`),
  ])("rejects an incomplete, invalid or oversized member list (%#)", (...members) => {
    expect(() => new AgentAssignment("acp-a", members)).toThrow();
  });
  it("rejects an invalid scope instead of falling back to a different Agent", () => {
    const assignment = new AgentAssignment("acp-a", ["acp-a"]);
    expect(() => assignment.owns({ organizationId: "", agentId: "a" })).toThrow();
  });

  it("keeps the full catalog preference but takes over a positively stopped member's partition", () => {
    const scope = { organizationId: "organization-1", agentId: "agent-1" };
    const members = ["acp-a", "acp-b"];
    const preferred = new AgentAssignment("acp-a", members).preferred(scope);
    const survivor = members.find((m) => m !== preferred)!;
    const registration = {
      member_id: survivor,
      registration_id: "11111111-1111-4111-8111-111111111111",
      incarnation_id: "22222222-2222-4222-8222-222222222222",
    };
    let view: PeerAvailabilityCapture = {
      guard: { membershipSha256: "a".repeat(64), revision: "2" },
      members: members.map((memberId) =>
        memberId === survivor
          ? { memberId, state: "running" as const, registration, stopped: [] }
          : { memberId, state: "stopped" as const, stopped: [] },
      ),
      live: [registration],
    };
    const assignment = new AgentAssignment(survivor, members, () => view);
    expect(assignment.preferred(scope)).toBe(preferred);
    expect(assignment.target(scope)).toBe(survivor);
    expect(assignment.owns(scope)).toBe(true);
    expect(members).toEqual(["acp-a", "acp-b"]);
    view = {
      ...view,
      members: members.map((memberId) =>
        memberId === survivor
          ? { memberId, state: "running" as const, registration, stopped: [] }
          : { memberId, state: "unregistered" as const },
      ),
    };
    expect(assignment.target(scope)).toBe(preferred);
    expect(assignment.owns(scope)).toBe(false);
  });

  function acquisitionFixture() {
    const scope = { organizationId: "organization-1", agentId: "agent-1" };
    const members = ["acp-a", "acp-b"];
    const preferred = new AgentAssignment("acp-a", members).preferred(scope);
    const survivor = members.find((member) => member !== preferred)!;
    const local = Object.freeze({
      member_id: survivor,
      registration_id: "11111111-1111-4111-8111-111111111111",
      incarnation_id: "22222222-2222-4222-8222-222222222222",
    });
    const stopped = Object.freeze({
      member_id: preferred,
      registration_id: "33333333-3333-4333-8333-333333333333",
      incarnation_id: "44444444-4444-4444-8444-444444444444",
      state: "stopped" as const,
      stop_receipt: Object.freeze({
        receipt_id: "77777777-7777-4777-8777-777777777777",
        reason: "container_stopped" as const,
        observed_at: "2026-10-24T00:00:00.000Z",
      }),
    });
    const rejoined = Object.freeze({
      member_id: preferred,
      registration_id: "55555555-5555-4555-8555-555555555555",
      incarnation_id: "66666666-6666-4666-8666-666666666666",
    });
    const original: PeerAvailabilityCapture = Object.freeze({
      guard: Object.freeze({ membershipSha256: "a".repeat(64), revision: "2" }),
      members: Object.freeze(
        members.map((memberId) =>
          memberId === survivor
            ? Object.freeze({
                memberId,
                state: "running" as const,
                registration: local,
                stopped: [],
              })
            : Object.freeze({ memberId, state: "stopped" as const, stopped: [stopped] }),
        ),
      ),
      live: Object.freeze([local]),
    });
    let current = original;
    const captures: PeerAvailabilityCapture[] = [];
    const assignment = new AgentAssignment(survivor, members, () => {
      captures.push(current);
      return current;
    });
    return {
      assignment,
      scope,
      preferred,
      local,
      stopped,
      rejoined,
      original,
      captures,
      use: (next: PeerAvailabilityCapture) => {
        current = next;
      },
    };
  }

  it("rejects an old takeover candidate instead of borrowing the guard of a rejoined member", () => {
    const f = acquisitionFixture();
    expect(f.assignment.owns(f.scope)).toBe(true);
    const rejoined: PeerAvailabilityCapture = Object.freeze({
      guard: Object.freeze({ membershipSha256: "a".repeat(64), revision: "3" }),
      members: Object.freeze(
        f.original.members.map((member) =>
          member.memberId === f.preferred
            ? Object.freeze({
                memberId: member.memberId,
                state: "running" as const,
                registration: f.rejoined,
                stopped: [f.stopped],
              })
            : member,
        ),
      ),
      live: Object.freeze([f.local, f.rejoined]),
    });
    f.use(rejoined);
    expect(f.assignment.target(f.scope)).toBe(f.preferred);
    f.captures.length = 0;

    expect(() => f.assignment.acquireGuard(f.scope)).toThrow(AgentOwnershipLostError);
    expect(f.captures).toHaveLength(1);
    expect(f.captures[0]).toBe(rejoined);
  });

  it("returns the guard of the single current capture when the new version still assigns locally", () => {
    const f = acquisitionFixture();
    expect(f.assignment.owns(f.scope)).toBe(true);
    const stoppedAgain = Object.freeze({
      ...f.rejoined,
      state: "stopped" as const,
      stop_receipt: Object.freeze({
        receipt_id: "88888888-8888-4888-8888-888888888888",
        reason: "container_stopped" as const,
        observed_at: "2026-10-24T00:00:01.000Z",
      }),
    });
    const current: PeerAvailabilityCapture = Object.freeze({
      guard: Object.freeze({ membershipSha256: "a".repeat(64), revision: "3" }),
      members: Object.freeze(
        f.original.members.map((member) =>
          member.memberId === f.preferred
            ? Object.freeze({
                memberId: member.memberId,
                state: "stopped" as const,
                stopped: [f.stopped, stoppedAgain],
              })
            : member,
        ),
      ),
      live: Object.freeze([f.local]),
    });
    f.use(current);
    f.captures.length = 0;

    expect(f.assignment.acquireGuard(f.scope)).toBe(current.guard);
    expect(f.captures).toHaveLength(1);
    expect(f.captures[0]).toBe(current);
    expect(current.guard.revision).toBe("3");
    expect(f.original.guard.revision).toBe("2");
  });
});
