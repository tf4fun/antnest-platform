import { describe, expect, it } from "vitest";
import { trustedAuditPrincipal, trustedIdentity } from "../../src/transport/trusted-identity.js";

const headers = {
  "x-antnest-organization-id": "organization-1",
  "x-antnest-principal-id": "principal-1",
  "x-antnest-agent-id": "agent-1",
};

describe("trusted Gateway identity", () => {
  it("takes one complete identity tuple, not an Agent access subject", () => {
    expect(trustedIdentity(headers)).toEqual({
      organizationId: "organization-1",
      principalId: "principal-1",
      agentId: "agent-1",
    });
    expect(trustedIdentity({ "x-antnest-agent-access-subject": "old-subject" })).toBeNull();
  });

  it.each(Object.keys(headers))("preserves opaque values in %s", (key) => {
    for (const value of [
      "principal+service@example.org",
      "agent/department:1",
      "id~[opaque]",
      "department member",
      "x",
      "x".repeat(200),
    ]) {
      const input = { ...headers, [key]: value };
      expect(trustedIdentity(input)).toEqual({
        organizationId: input["x-antnest-organization-id"],
        principalId: input["x-antnest-principal-id"],
        agentId: input["x-antnest-agent-id"],
      });
    }
  });

  it.each(Object.keys(headers))("requires %s", (key) => {
    expect(trustedIdentity({ ...headers, [key]: undefined })).toBeNull();
  });

  it.each([
    "",
    " ",
    " padded",
    "padded ",
    "a,b",
    "x".repeat(201),
    "a\nb",
    "a\rb",
    "a\tb",
    "a\u0000b",
    "a\u007fb",
    "unrepresentable\u0100",
    ["first", "second"],
  ])("rejects ambiguous or invalid identity %j", (value) => {
    expect(trustedIdentity({ ...headers, "x-antnest-principal-id": value })).toBeNull();
  });
});

describe("trusted management identity", () => {
  const managementHeaders = {
    "x-antnest-user-id": "admin+operations@example.org",
    "x-antnest-organization-id": "org+department@example.org",
    "x-antnest-membership-id": "membership+[1]",
    "x-antnest-system-role": "user",
    "x-antnest-organization-role": "admin",
  };

  it("preserves opaque identifiers without interpreting them as roles", () => {
    expect(trustedAuditPrincipal(managementHeaders)).toEqual({
      principalId: managementHeaders["x-antnest-user-id"],
      organizationId: managementHeaders["x-antnest-organization-id"],
      membershipId: managementHeaders["x-antnest-membership-id"],
      systemRole: "user",
      organizationRole: "admin",
    });
    expect(
      trustedAuditPrincipal({ ...managementHeaders, "x-antnest-system-role": "root" }),
    ).toBeNull();
  });

  it.each(["x-antnest-user-id", "x-antnest-organization-id", "x-antnest-membership-id"])(
    "rejects ambiguous values in %s",
    (key) => {
      for (const value of [
        undefined,
        "",
        " padded",
        "padded ",
        "a,b",
        "a\tb",
        "a\nb",
        "x".repeat(201),
        ["first", "second"],
      ]) {
        expect(trustedAuditPrincipal({ ...managementHeaders, [key]: value })).toBeNull();
      }
    },
  );
});
