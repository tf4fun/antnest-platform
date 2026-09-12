import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeNetworkPolicy,
  decodeNetworkAssignment,
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
