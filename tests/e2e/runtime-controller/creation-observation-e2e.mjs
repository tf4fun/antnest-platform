import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.ANTNEST_RUNTIME_CONTROLLER_TEST_URL;
const configuration = JSON.parse(
  process.env.ANTNEST_RUNTIME_TEST_CONFIGURATION ?? "null",
);
assert.ok(
  base && configuration,
  "a dedicated test Controller URL and Runtime configuration are required",
);
const agent =
  process.env.ANTNEST_RUNTIME_TEST_AGENT_ID ??
  `agent-observation-${randomBytes(8).toString("hex")}`;
const path = `/internal/runtimes/${agent}`;
let revision;

async function request(route, payload, key) {
  const response = await fetch(new URL(route, base), {
    method: payload ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(response.status, 200, `${route}: ${response.status}`);
  return response.json();
}

async function mutate(action, payload) {
  const result = await request(
    `${path}/${action}`,
    payload,
    `${agent}-${action}`,
  );
  assert.equal(result.state, "completed");
  revision = result.target_revision;
  assert.ok(revision);
  return result;
}

function assertProvisioned(result) {
  assert.equal(result.inspection.lifecycle_state, "provisioned");
  assert.equal(result.inspection.health, "unknown");
  assert.ok(!result.inspection.runtime_execution_id);
}

async function observeReady() {
  const deadline = Date.now() + 60_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await request(path);
    assert.equal(snapshot.runtime_revision, revision);
    assert.equal(snapshot.lifecycle_state, "provisioned");
    if (snapshot.health === "healthy") {
      assert.ok(snapshot.runtime_execution_id);
      assert.ok(snapshot.mcp_endpoint);
      return;
    }
    await delay(500);
  }
  throw new Error(
    `separate readiness observation timed out: ${JSON.stringify(snapshot)}`,
  );
}

try {
  const initialized = await mutate("initialize", { configuration });
  assertProvisioned(initialized);
  await observeReady();
  const replay = await request(
    `${path}/initialize`,
    { configuration },
    `${agent}-initialize`,
  );
  assert.deepEqual(
    replay,
    initialized,
    "readiness must not rewrite the saved creation result",
  );

  const updated = await mutate("update", {
    expected_revision: revision,
    configuration,
  });
  assertProvisioned(updated);
  const disabled = await mutate("disable", { expected_revision: revision });
  assert.equal(disabled.inspection.lifecycle_state, "disabled");
  const enabled = await mutate("enable", {
    expected_revision: revision,
    configuration,
  });
  assertProvisioned(enabled);
} finally {
  // Cleanup also covers a creation response lost after the platform mutation.
  const snapshot = await request(path);
  if (snapshot.lifecycle_state !== "deleted") {
    const deleted = await mutate("delete", {
      expected_revision: snapshot.runtime_revision,
    });
    assert.equal(deleted.inspection.lifecycle_state, "deleted");
  }
}

console.log(
  JSON.stringify({
    result: "passed",
    agent_id: agent,
    assertions: [
      "creation_without_readiness",
      "independent_ready_observation",
      "immutable_replay",
      "update_disable_enable_delete_without_readiness_wait",
    ],
  }),
);
