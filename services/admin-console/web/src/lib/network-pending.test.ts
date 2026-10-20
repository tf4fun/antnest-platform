import assert from "node:assert/strict";
import test from "node:test";
import { decodeNetworkPolicy } from "./network-policy.ts";

test("pending network snapshots preserve independent versions and drop private fields", () => {
  const policy = {
    agent_id: "agent-1",
    action: "allow_all",
    resource_version: 7,
    attachment: { state: "pending", resource_version: 2 },
  };
  assert.deepEqual(
    decodeNetworkPolicy(
      {
        ...policy,
        attachment: { ...policy.attachment, tunnel_key_id: "private" },
      },
      "agent-1",
    ),
    policy,
  );
  for (const resource_version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      decodeNetworkPolicy(
        { ...policy, attachment: { state: "pending", resource_version } },
        "agent-1",
      ),
    );
  }
});
