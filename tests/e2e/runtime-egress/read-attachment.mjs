// Runs only in a disposable probe on the fixture's Egress control network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const [base, agentID] = process.argv.slice(2);
assert.match(agentID, /^agent_[a-f0-9]{32}$/u);
const response = await fetch(`${base}/internal/agent-networks/${agentID}`, {
  headers: {
    "Antnest-Service-Authorization": `Bearer ${readFileSync("/proof/token", "utf8").trim()}`,
  },
  signal: AbortSignal.timeout(10000),
});
assert.equal(response.status, 200, "Egress attachment inspection failed");
const value = await response.json();
assert.equal(value.agent_id, agentID);
console.log(JSON.stringify(value));
