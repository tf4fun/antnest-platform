import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const callers = JSON.parse(
  readFileSync(
    new URL("../../../contracts/admin-console/callers.json", import.meta.url),
    "utf8",
  ),
);

for (const path of [
  "/api/admin/agents/{agent_id}/lifecycle-operation/cancel",
  "/api/admin/agents/{agent_id}/lifecycle-quarantine/clear",
]) {
  test(`lifecycle mutation ${path} requires the trusted gateway caller context`, () => {
    assert.deepEqual(callers.routes[`POST ${path}`], {
      callers: ["edge-gateway"],
      authentication: "workload",
      caller_context: { "edge-gateway": "required" },
      request_body: "json",
    });
  });
}
