import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDisableFault } from "./source-recovery-rc-proxy.mjs";

test("source recovery fault proxy targets only the configured Agent's Disable", () => {
  const fault = {
    agentID: `agent_${"a".repeat(32)}`,
    mode: "unknown_once",
    calls: 0,
  };
  assert.equal(
    classifyDisableFault(fault, "GET", `/internal/runtimes/${fault.agentID}`),
    "forward",
  );
  assert.equal(
    classifyDisableFault(
      fault,
      "POST",
      `/internal/runtimes/agent_${"b".repeat(32)}/disable`,
    ),
    "forward",
  );
  assert.equal(
    classifyDisableFault(
      fault,
      "POST",
      `/internal/runtimes/${fault.agentID}/disable`,
    ),
    "unknown_once",
  );
  fault.calls = 1;
  assert.equal(
    classifyDisableFault(
      fault,
      "POST",
      `/internal/runtimes/${fault.agentID}/disable`,
    ),
    "forward",
  );
  fault.mode = "reject";
  assert.equal(
    classifyDisableFault(
      fault,
      "POST",
      `/internal/runtimes/${fault.agentID}/disable`,
    ),
    "reject",
  );
});
