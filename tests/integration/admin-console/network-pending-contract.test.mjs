import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Console declares pending as a confirmed attachment snapshot without authority to open it", () => {
  const contract = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/admin-console/admin-contract.json",
        import.meta.url,
      ),
    ),
  );
  assert(contract.version >= 55);
  const policy = contract.response_policy.agent_network_policy;
  assert.deepEqual(policy.attachment_states, ["open", "closed", "pending"]);
  assert.equal(
    policy.attachment_snapshot,
    "last_confirmed_read_not_live_health_or_execution",
  );
  assert.equal(
    policy.side_effects,
    "no_agent_revision_runtime_rebuild_or_attachment_open",
  );
});
