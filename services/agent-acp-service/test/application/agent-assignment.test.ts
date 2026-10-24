import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentAssignment } from "../../src/application/agent-assignment.js";

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
});
