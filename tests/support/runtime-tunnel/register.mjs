// Native Runtime fixture only; actual lifecycle generation keys are issued by RC.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const [origin, agent] = process.argv.slice(2);
const token = readFileSync("/fixture/token", "utf8");
const response = await fetch(
  `${origin}/internal/agent-tunnel-keys/${encodeURIComponent(agent)}`,
  {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "Antnest-Service-Authorization": `Bearer ${token}`,
    },
    body: readFileSync("/fixture/keys.json"),
    signal: AbortSignal.timeout(10000),
  },
);
assert.equal(response.status, 204, "fixture generation registration failed");
await response.arrayBuffer();
