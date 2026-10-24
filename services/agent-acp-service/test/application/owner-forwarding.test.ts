import { describe, expect, it } from "vitest";
import { encodeOwnerForward, parseOwnerForward } from "../../src/application/owner-forwarding.js";

const registration = (member_id: string, value: string) => ({
  member_id,
  registration_id: `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`,
  incarnation_id: `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-9${value.repeat(3)}-${value.repeat(12)}`,
});

describe("owner forwarding envelope", () => {
  const value = {
    request_id: "5e99a3e0-f416-4b8d-a0b9-cc3c552911c5",
    deadline_at: "2026-10-24T05:00:00.000Z",
    membership_sha256: "a".repeat(64),
    source: registration("acp-a", "a"),
    target: registration("acp-b", "b"),
    publication: {
      organization_id: "organization-1",
      revision: 1,
      authority_sha256: "b".repeat(64),
    },
    identity: { organizationId: "organization-1", principalId: "principal-1", agentId: "agent-3" },
    epoch: "1",
    protocol: "v1",
    caller: "agent-ui",
    hop: 1,
  };
  it("round trips a closed routing envelope without changing its original deadline", () => {
    expect(parseOwnerForward(encodeOwnerForward(value))).toEqual(value);
  });
  it.each([
    { hop: 2 },
    { caller: "agent-acp-service" },
    { epoch: "01" },
    { epoch: "9223372036854775808" },
    { protocol: "v3" },
    { destination: "http://request-selected.invalid" },
    { identity: { organizationId: "other", principalId: "principal-1", agentId: "agent-3" } },
  ])("rejects invalid routing context %j", (change) => {
    expect(() =>
      parseOwnerForward(Buffer.from(JSON.stringify({ ...value, ...change })).toString("base64url")),
    ).toThrow();
  });
  it("rejects noncanonical base64 and oversized headers", () => {
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(() => parseOwnerForward(encoded + "=")).toThrow();
    expect(() => parseOwnerForward("a".repeat(16385))).toThrow();
  });
});
