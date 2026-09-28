import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldHoldPublishRead } from "./source-recovery-egress-proxy.mjs";

test("Egress fault proxy holds only the target recovery's publication recheck", () => {
  const fault = {
    agentID: `agent_${"a".repeat(32)}`,
    mode: "hold_publish",
    reads: 0,
    held: false,
  };
  const target = `/internal/agent-networks/${fault.agentID}`;
  assert.equal(shouldHoldPublishRead(fault, "PUT", target), false);
  assert.equal(
    shouldHoldPublishRead(
      fault,
      "GET",
      `/internal/agent-networks/agent_${"b".repeat(32)}`,
    ),
    false,
  );
  assert.equal(shouldHoldPublishRead(fault, "GET", target), false);
  fault.reads = 2;
  assert.equal(shouldHoldPublishRead(fault, "GET", target), true);
  fault.held = true;
  assert.equal(shouldHoldPublishRead(fault, "GET", target), false);
});
