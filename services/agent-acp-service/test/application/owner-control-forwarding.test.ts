import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  controlBodyDigest,
  encodeOwnerControl,
  parseOwnerControl,
} from "../../src/application/owner-control-forwarding.js";
import { agentExecutionStateRequestSchema } from "../../src/domain/agent-execution-state.js";
import { parseAgentSettlement } from "../../src/domain/agent-settlement.js";
import {
  skillSourceArtifactSchema,
  skillSourceInspectSchema,
} from "../../src/domain/skill-source.js";

const registration = (member_id: string, value: string) => ({
  member_id,
  registration_id: `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`,
  incarnation_id: `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-9${value.repeat(3)}-${value.repeat(12)}`,
});
const organizationId = `org_${"a".repeat(32)}`;
const agentId = `agent_${"b".repeat(32)}`;
const principalId = `user_${"c".repeat(32)}`;
const source = registration("acp-a", "a");
const target = registration("acp-b", "b");
const publication = {
  organization_id: organizationId,
  revision: 1,
  authority_sha256: "b".repeat(64),
};
const identity = { organizationId, principalId, agentId };
const operations = [
  ["state-read", "agent-ui"],
  ["state-watch", "agent-ui"],
  ["settlement", "agent-controller"],
  ["source-inspect", "skill-registry"],
  ["source-artifact", "skill-registry"],
] as const;
type Operation = (typeof operations)[number][0];

function body(operation: Operation) {
  if (operation === "state-read" || operation === "state-watch")
    return agentExecutionStateRequestSchema.parse({});
  if (operation === "settlement")
    return parseAgentSettlement({
      organization_id: organizationId,
      agent_id: agentId,
      minimum_revision: 1,
      operation_id: "operation-1",
      mode: "wait",
      deadline_at: "2026-10-24T05:01:00.000Z",
    });
  if (operation === "source-inspect")
    return skillSourceInspectSchema.parse({
      organization_id: organizationId,
      actor_id: principalId,
      sources: [{ agent_id: agentId, name: "example-skill" }],
    });
  return skillSourceArtifactSchema.parse({
    organization_id: organizationId,
    actor_id: principalId,
    skill_ref: { kind: "agent", agent_id: agentId, name: "example-skill", sequence: 1 },
    expected_digest: `sha256:${"d".repeat(64)}`,
  });
}

function context(operation: Operation) {
  const common = {
    operation,
    caller: operations.find(([selected]) => selected === operation)![1],
    request_id: "5e99a3e0-f416-4b8d-a0b9-cc3c552911c5",
    deadline_at: new Date(Date.now() + 5000).toISOString(),
    membership_sha256: "a".repeat(64),
    source,
    target,
    publication,
    body_sha256: controlBodyDigest(body(operation)),
    hop: 1,
  };
  return operation === "settlement"
    ? { ...common, scope: { organizationId, agentId } }
    : { ...common, identity, epoch: "1" };
}

const wire = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("owner control forwarding envelope", () => {
  it.each(operations)("round trips the closed %s/%s context", (operation) => {
    const value = context(operation);
    expect(parseOwnerControl(encodeOwnerControl(value))).toEqual(value);
  });

  it("retains the original admission deadline after time passes", () => {
    const now = Date.parse("2026-10-24T05:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const value = context("state-watch");
      const encoded = encodeOwnerControl(value);
      clock.mockReturnValue(now + 1000);
      expect(parseOwnerControl(encoded)).toEqual(value);
      expect(parseOwnerControl(encoded).deadline_at).toBe("2026-10-24T05:00:05.000Z");
    } finally {
      clock.mockRestore();
    }
  });

  it.each(operations)("binds %s to only its original caller %s", (operation, expected) => {
    const value = context(operation);
    for (const caller of ["agent-ui", "agent-controller", "skill-registry", "agent-acp-service"])
      if (caller !== expected) {
        expect(() => encodeOwnerControl({ ...value, caller })).toThrow();
        expect(() => parseOwnerControl(wire({ ...value, caller }))).toThrow();
      }
  });

  it.each(operations)("rejects a foreign publication organization for %s", (operation) => {
    const value = {
      ...context(operation),
      publication: { ...publication, organization_id: "other" },
    };
    expect(() => encodeOwnerControl(value)).toThrow();
    expect(() => parseOwnerControl(wire(value))).toThrow();
  });

  it.each(["state-read", "state-watch", "source-inspect", "source-artifact"] as const)(
    "%s requires identity and a canonical live execution epoch, without settlement scope",
    (operation) => {
      const value = context(operation);
      for (const epoch of [undefined, "", "0", "01", "-1", "1.0", 1, "9223372036854775808"])
        expect(() => parseOwnerControl(wire({ ...value, epoch }))).toThrow();
      expect(() => parseOwnerControl(wire({ ...value, identity: undefined }))).toThrow();
      expect(() =>
        parseOwnerControl(wire({ ...value, scope: { organizationId, agentId } })),
      ).toThrow();
      expect(() =>
        parseOwnerControl(wire({ ...value, identity: { ...identity, organizationId: "other" } })),
      ).toThrow();
      expect(() =>
        parseOwnerControl(
          wire({
            ...value,
            identity: { ...identity, destination: "http://request-selected.invalid" },
          }),
        ),
      ).toThrow();
      expect(parseOwnerControl(wire({ ...value, epoch: "9223372036854775807" }))).toMatchObject({
        epoch: "9223372036854775807",
      });
    },
  );

  it("settlement requires closed-operation scope and carries neither user identity nor epoch", () => {
    const value = context("settlement");
    for (const change of [
      { identity },
      { epoch: "1" },
      { scope: undefined },
      { scope: { organizationId: "other", agentId } },
      { scope: { organizationId, agentId, principalId } },
      { scope: { organizationId, agentId: "" } },
    ])
      expect(() => parseOwnerControl(wire({ ...value, ...change }))).toThrow();
  });

  it.each([
    { operation: "request" },
    { operation: "https://request-selected.invalid/settle" },
    { hop: 0 },
    { hop: 2 },
    { hop: "1" },
    { destination: "http://request-selected.invalid" },
    { url: "http://request-selected.invalid" },
    { method: "GET" },
    { protocol: "v1" },
    { request_id: "not-a-uuid" },
    { deadline_at: "2026-02-30T05:00:00.000Z" },
    { membership_sha256: "A".repeat(64) },
    { body_sha256: "sha256:" + "c".repeat(64) },
    { body_sha256: "c".repeat(63) },
    { body_sha256: "C".repeat(64) },
    { body_sha256: undefined },
    { source: { ...source, member_id: "../acp-a" } },
    { target: { ...target, incarnation_id: "unknown-incarnation" } },
    { target: { ...target, origin: "http://request-selected.invalid" } },
    { publication: { ...publication, secret: "not-a-wire-field" } },
  ])("rejects unknown or malformed control context %j", (change) => {
    const value = { ...context("state-read"), ...change };
    expect(() => encodeOwnerControl(value)).toThrow();
    expect(() => parseOwnerControl(wire(value))).toThrow();
  });

  it("rejects duplicate JSON members at the envelope and registration boundaries", () => {
    const raw = JSON.stringify(context("state-read"));
    for (const duplicate of [
      raw.replace('"hop":1', '"hop":1,"hop":1'),
      raw.replace('"member_id":"acp-a"', '"member_id":"acp-a","member_id":"acp-a"'),
    ])
      expect(() => parseOwnerControl(Buffer.from(duplicate).toString("base64url"))).toThrow();
  });

  it("rejects noncanonical base64url, invalid JSON/UTF-8 and oversized headers", () => {
    const encoded = wire(context("state-read"));
    for (const invalid of [
      "",
      encoded + "=",
      encoded + ".",
      "not+url/base64",
      Buffer.from("[]").toString("base64url"),
      Buffer.from([0xff]).toString("base64url"),
      "a".repeat(16385),
    ])
      expect(() => parseOwnerControl(invalid)).toThrow();
  });
});

describe("control request body digest", () => {
  it.each(operations)("hashes the schema-normalized original %s input", (operation) => {
    const input = body(operation);
    expect(controlBodyDigest(input)).toBe(
      createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    );
    expect(controlBodyDigest(input)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("binds settlement mode/deadline and source sequence/digest without rewriting them", () => {
    const input = body("settlement");
    const selected = skillSourceArtifactSchema.parse(body("source-artifact"));
    expect(controlBodyDigest({ ...input, mode: "cancel" })).not.toBe(controlBodyDigest(input));
    expect(controlBodyDigest({ ...input, deadline_at: "2026-10-24T05:01:01.000Z" })).not.toBe(
      controlBodyDigest(input),
    );
    expect(
      controlBodyDigest({ ...selected, expected_digest: `sha256:${"e".repeat(64)}` }),
    ).not.toBe(controlBodyDigest(selected));
    expect(
      controlBodyDigest({
        ...selected,
        skill_ref: { ...selected.skill_ref, sequence: selected.skill_ref.sequence + 1 },
      }),
    ).not.toBe(controlBodyDigest(selected));
  });
});
