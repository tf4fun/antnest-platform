import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePeerMembership, parsePeerReceiver } from "../../src/adapters/peer-authentication.js";
import {
  authenticateFields,
  SERVICE_AUTH_HEADER,
} from "../../src/adapters/service-authentication.js";

const cluster = "10000000-0000-4000-8000-000000000001";
const roster = () => ({
  version: 1,
  cluster_id: cluster,
  members: [
    { member_id: "acp-b", origin: "https://acp-b.internal:8083" },
    { member_id: "acp-a", origin: "https://acp-a.internal:8083" },
  ],
});
const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
const hash = (token: string) => `sha256:${createHash("sha256").update(token).digest("hex")}`;

describe("operator peer membership", () => {
  it("pins a complete immutable roster and derives the same canonical digest on every member", () => {
    const input = roster();
    const a = parsePeerMembership(raw(input), "acp-a");
    input.members.reverse();
    const b = parsePeerMembership(raw(input), "acp-b");
    const canonical = `{"cluster_id":"${cluster}","members":[{"member_id":"acp-a","origin":"https://acp-a.internal:8083"},{"member_id":"acp-b","origin":"https://acp-b.internal:8083"}],"version":1}`;
    expect(a.sha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(a.sha256).toBe(b.sha256);
    expect(a.members.map((member) => member.member_id)).toEqual(["acp-a", "acp-b"]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.members)).toBe(true);
    expect(a.members.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    "https://acp-b.internal:8083/path",
    "https://acp-b.internal:8083/",
    "https://user:secret@acp-b.internal:8083",
    "https://acp-b.internal:8083?target=other",
    "https://acp-b.internal:8083#other",
    "https://ACP-B.internal:8083",
    "https://acp-b.internal:443",
    "https://acp-b.internal\\other",
    "file:///etc/passwd",
  ])("rejects noncanonical or request-like origin %s", (origin) => {
    const input = roster();
    input.members[0]!.origin = origin;
    expect(() => parsePeerMembership(raw(input), "acp-a")).toThrow(
      "acp_peer_configuration_invalid",
    );
  });

  it("rejects incomplete, ambiguous and extra-field catalogs rather than dropping members", () => {
    const input = roster();
    for (const value of [
      { ...input, container_selector: "untrusted" },
      { ...input, cluster_id: "invalid" },
      { ...input, members: [] },
      { ...input, members: [input.members[0], input.members[0]] },
      {
        ...input,
        members: [input.members[0], { ...input.members[1], origin: input.members[0]!.origin }],
      },
      { ...input, members: [{ ...input.members[0], member_id: "../tokens" }, input.members[1]] },
      { ...input, members: [{ ...input.members[0], token: "secret" }, input.members[1]] },
    ])
      expect(() => parsePeerMembership(raw(value), "acp-a")).toThrow(
        "acp_peer_configuration_invalid",
      );
    expect(() => parsePeerMembership(raw(input), "acp-c")).toThrow(
      "acp_peer_configuration_invalid",
    );
    expect(() => parsePeerMembership(Buffer.from('{"version":1,"version":1}'), "acp-a")).toThrow(
      "acp_peer_configuration_invalid",
    );
  });
});

describe("directional peer receiver credentials", () => {
  it("resolves current and next tokens to the fixed source and rejects ordinary or duplicate credentials", () => {
    const current = randomBytes(32).toString("base64url");
    const next = randomBytes(32).toString("base64url");
    const receiver = parsePeerReceiver(raw({ "acp-b": [hash(current), hash(next)] }), ["acp-b"]);
    for (const token of [current, next]) {
      expect(
        authenticateFields(
          receiver,
          [{ name: SERVICE_AUTH_HEADER, value: `Bearer ${token}` }],
          ["acp-b"],
        ).caller,
      ).toBe("acp-b");
    }
    const fields = [{ name: SERVICE_AUTH_HEADER, value: `Bearer ${current}` }];
    expect(authenticateFields(receiver, [...fields, ...fields], ["acp-b"]).http_status).toBe(401);
    expect(
      authenticateFields(
        receiver,
        [{ name: SERVICE_AUTH_HEADER, value: `Bearer ${randomBytes(32).toString("base64url")}` }],
        ["acp-b"],
      ).http_status,
    ).toBe(401);
    expect(authenticateFields(receiver, fields, ["acp-c"]).http_status).toBe(403);
  });

  it("rejects missing members, logical-service grants and credential reuse between source identities", () => {
    const tokenHash = hash(randomBytes(32).toString("base64url"));
    for (const value of [
      {},
      { "agent-acp-service": [tokenHash] },
      { "acp-b": [] },
      { "acp-b": [tokenHash, tokenHash] },
      { "acp-b": ["sha256:bad"] },
      { "acp-b": [tokenHash], "acp-c": [tokenHash] },
    ])
      expect(() => parsePeerReceiver(raw(value), ["acp-b", "acp-c"])).toThrow(
        "acp_peer_configuration_invalid",
      );
    expect(() => parsePeerReceiver(Buffer.from('{"acp-b":[],"acp-b":[]}'), ["acp-b"])).toThrow(
      "acp_peer_configuration_invalid",
    );
  });
});
