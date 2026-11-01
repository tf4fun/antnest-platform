import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeNetworkPolicy,
  decodeNetworkAssignment,
  decodeNetworkSpec,
  networkFailureUncertain,
  pendingNetworkKey,
  readPendingNetwork,
  savePendingNetwork,
  clearPendingNetwork,
} from "./network-policy.ts";

const pending = {
  action: "allow_all" as const,
  expected_resource_version: 7,
  idempotency_key: "network-request-12345",
};
const policy = {
  agent_id: "agent-1",
  action: "deny_all",
  resource_version: 7,
  attachment: { state: "closed", resource_version: 4 },
};

test("network snapshots require exact Agent, supported action and safe versions", () => {
  assert.deepEqual(decodeNetworkPolicy(policy, "agent-1"), policy);
  for (const value of [
    null,
    {},
    { ...policy, agent_id: "other" },
    { ...policy, action: "unknown" },
    { ...policy, resource_version: 0 },
    { ...policy, resource_version: Number.MAX_SAFE_INTEGER + 1 },
    { ...policy, attachment: null },
    { ...policy, attachment: { state: "active", resource_version: 1 } },
  ]) {
    assert.throws(() => decodeNetworkPolicy(value, "agent-1"));
  }
});

test("acknowledgement cannot silently replace the original CAS intent", () => {
  const ack = { agent_id: "agent-1", action: "allow_all", resource_version: 8 };
  assert.deepEqual(decodeNetworkAssignment(ack, "agent-1", pending), ack);
  for (const value of [
    { ...ack, agent_id: "other" },
    { ...ack, action: "deny_all" },
    { ...ack, resource_version: 9 },
    null,
  ])
    assert.throws(() => decodeNetworkAssignment(value, "agent-1", pending));
});

test("scoped pending intent survives reload without leaking to another administrator", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  savePendingNetwork(storage, "org-1:user-1", "agent-1", pending);
  assert.deepEqual(
    readPendingNetwork(storage, "org-1:user-1", "agent-1"),
    pending,
  );
  assert.equal(
    readPendingNetwork(storage, "org-2:user-1", "agent-1"),
    undefined,
  );
  assert.equal(
    readPendingNetwork(storage, "org-1:user-2", "agent-1"),
    undefined,
  );
  assert.equal(
    readPendingNetwork(storage, "org-1:user-1", "agent-2"),
    undefined,
  );
  const second = { ...pending, idempotency_key: "second-network-request" };
  savePendingNetwork(storage, "org-1:user-1", "agent-1", second);
  clearPendingNetwork(storage, "org-1:user-1", "agent-1", pending);
  assert.deepEqual(
    readPendingNetwork(storage, "org-1:user-1", "agent-1"),
    second,
  );
  values.set(
    pendingNetworkKey("org-1:user-1", "agent-1", second.idempotency_key),
    "{broken",
  );
  assert.throws(() => readPendingNetwork(storage, "org-1:user-1", "agent-1"));
});

test("storage failure prevents dispatch and definite errors do not masquerade as ambiguous", () => {
  const storage = {
    setItem: () => {
      throw new Error("storage unavailable");
    },
  };
  assert.throws(() => savePendingNetwork(storage, "scope", "agent-1", pending));
  assert.throws(() => savePendingNetwork(storage, "", "agent-1", pending));
  for (const status of [200, 408, 429, 500, 502, 503])
    assert.equal(
      networkFailureUncertain(Object.assign(new Error(), { status })),
      true,
    );
  for (const status of [400, 401, 403, 404, 409, 410])
    assert.equal(
      networkFailureUncertain(Object.assign(new Error(), { status })),
      false,
    );
  assert.equal(networkFailureUncertain(new TypeError("network lost")), true);
});

const v2 = {
  schema_version: 2 as const,
  default: "deny" as const,
  rules: [
    { action: "allow" as const, domains: ["api.github.com"], ports: [443] },
    {
      action: "allow" as const,
      cidrs: ["10.20.0.15/32"],
      ports: [{ from: 400, to: 450 }],
    },
  ],
};
const pendingV2 = {
  spec: v2,
  expected_resource_version: 7,
  idempotency_key: "spec-pending-request-key",
};

test("v2 pending spec intents round-trip with canonical validation and stay scoped", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  savePendingNetwork(storage, "scope", "agent-1", pendingV2);
  const restored = readPendingNetwork(storage, "scope", "agent-1");
  assert.ok(restored && "spec" in restored);
  assert.deepEqual(restored.spec, v2);
  assert.equal(
    readPendingNetwork(storage, "other-scope", "agent-1"),
    undefined,
  );
});

test("v2 spec acknowledgements require canonical identity and expected version", () => {
  const ack = { agent_id: "agent-1", spec: v2, resource_version: 8 };
  assert.equal(
    decodeNetworkAssignment(ack, "agent-1", pendingV2).resource_version,
    8,
  );
  for (const value of [
    { ...ack, spec: { ...v2, default: "allow" } },
    { ...ack, spec: { ...v2, rules: [...v2.rules].reverse() } },
    { ...ack, resource_version: 9 },
    { ...ack, agent_id: "other" },
  ])
    assert.throws(() => decodeNetworkAssignment(value, "agent-1", pendingV2));
});

test("malformed specs and spec pending entries are rejected", () => {
  const candidates = [
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", ports: [0] }],
    },
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", cidrs: ["10.0.0.1/24"] }],
    },
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", cidrs: null }],
    },
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", domains: "example.com" }],
    },
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", ports: [{ from: 90, to: 80 }] }],
    },
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", protocol: "udp" }],
    },
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", extra: 1 }],
    },
    { schema_version: 2, default: "deny", rules: null },
    { schema_version: 1, action: "allow_all", rules: [] },
    {
      schema_version: 2,
      default: "deny",
      rules: [{ action: "allow", domains: ["Example.com"] }],
    },
  ];
  for (const candidate of candidates) {
    assert.throws(() => decodeNetworkSpec(candidate));
    assert.throws(() =>
      decodeNetworkAssignment(
        { agent_id: "agent-1", spec: candidate, resource_version: 8 },
        "agent-1",
        pendingV2,
      ),
    );
  }
});

test("CIDR boundaries accept canonical forms and reject malformed ones", () => {
  for (const cidr of [
    "0.0.0.0/0",
    "10.20.0.15/32",
    "192.168.0.0/16",
    "10.0.0.0/8",
  ]) {
    const spec = {
      schema_version: 2 as const,
      default: "deny" as const,
      rules: [{ action: "allow" as const, cidrs: [cidr] }],
    };
    assert.deepEqual(decodeNetworkSpec(spec).schema_version, 2);
  }
  for (const cidr of [
    "10.0.0.0/01",
    "10.0.0.0/08",
    "10.0.0.0/00",
    "10.0.0.0/033",
    "010.0.0.0/8",
    "10.0.0.1/8",
    "10.0.0.0/33",
    "10.0.0.256/8",
    "1.0.0.0/0",
  ]) {
    const spec = {
      schema_version: 2 as const,
      default: "deny" as const,
      rules: [{ action: "allow" as const, cidrs: [cidr] }],
    };
    assert.throws(() => decodeNetworkSpec(spec), undefined, cidr);
  }
});

test("pending intents reject dual channels, invalid ids, versions and specs", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const base = {
    expected_resource_version: 7,
    idempotency_key: "valid-request-key-16",
  };
  for (const pending of [
    { ...base, action: "deny_all", spec: v2 },
    { ...base, action: "invalid" },
    { ...base, action: "allow_all", expected_resource_version: 0 },
    {
      ...base,
      spec: v2,
      expected_resource_version: Number.MAX_SAFE_INTEGER + 1,
    },
    { ...base, spec: v2, idempotency_key: "short" },
    { ...base, spec: { ...v2, default: "invalid" } },
    { ...base },
  ]) {
    assert.throws(() =>
      savePendingNetwork(storage, "scope", "agent-1", pending as never),
    );
  }
});
