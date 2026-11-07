import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadGolden, validateGolden } from "../../support/contracts/golden.mjs";
import {
  collectContractRoutes,
  routeParityProblems,
} from "../../support/contracts/route-parity.mjs";
import { checkRepository } from "../../support/check-service-authentication.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const contractFile = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const manifest = JSON.parse(
  readFileSync(join(root, "contracts/golden-manifest.json"), "utf8"),
);
const entries = Array.isArray(manifest) ? manifest : manifest.examples;
const callerRoutes = (rel) => {
  const callers = contractFile(rel);
  const routes = callers.routes ?? callers;
  return Object.keys(routes).filter(
    (key) => !key.startsWith("* ") && key.includes(" "),
  );
};

test("manifest declares exactly the settled producer-consumer pairs", () => {
  const pairs = new Set();
  for (const entry of entries)
    for (const consumer of entry.consumers)
      pairs.add(`${entry.producer}->${consumer}`);
  assert.deepEqual(
    [...pairs].sort(),
    [
      "agent-acp-service->admin-console",
      "agent-acp-service->agent-ui",
      "agent-controller->admin-console",
      "agent-controller->agent-acp-service",
      "antnest-runtime->agent-acp-service",
      "identity-service->agent-controller",
      "identity-service->edge-gateway",
      "runtime-controller->agent-controller",
      "runtime-controller->antnest-runtime",
      "runtime-egress->agent-controller",
    ].sort(),
  );
  const learningPolicy = entries.find(
    (entry) =>
      entry.file === "skill-learning/examples/learning-policy.automatic.json",
  );
  assert.deepEqual(learningPolicy.consumers, ["agent-acp-service"]);
});

test("frozen N-1 and current markers are exactly as published", () => {
  const marker = (file, key = "schema_version") =>
    contractFile(`contracts/${file}`)[key];
  assert.equal(
    marker("agent-acp/examples/execution-snapshot.n-1-ready.json"),
    undefined,
  );
  assert.equal(marker("agent-acp/examples/execution-snapshot.ready.json"), 1);
  assert.equal(marker("agent-acp/examples/execution-snapshot.v2.json"), 2);
  assert.equal(marker("runtime/examples/runtime-spec.n-1.json"), undefined);
  assert.equal(marker("runtime/examples/runtime-spec.current.json"), 1);

  const observationRows = (file) =>
    contractFile(`contracts/${file}`).observations.map(
      (row) => row.schema_version,
    );
  assert.deepEqual(
    observationRows("runtime/examples/rc-observations.n-1.json"),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    observationRows("runtime/examples/rc-observations.current.json"),
    [1, 1, 1],
  );

  const auditRows = (file) => {
    const document = contractFile(`contracts/${file}`);
    return [
      document.schema_version,
      ...document.items.map((item) => item.schema_version),
    ];
  };
  assert.deepEqual(auditRows("agent-acp/examples/execution-events.n-1.json"), [
    undefined,
    undefined,
  ]);
  assert.deepEqual(
    auditRows("agent-acp/examples/execution-events.current.json"),
    [1, 1],
  );
  assert.deepEqual(
    auditRows("agent-acp/examples/execution-events.permissions.json"),
    [1, 1],
  );

  for (const row of contractFile(
    "contracts/agent-controller/examples/list-events.ready.json",
  ).events)
    assert.ok(row.schema_version === 1 || row.schema_version === 2);
});

test("real producer goldens validate against their registered schemas", async () => {
  for (const entry of entries)
    await validateGolden(
      entry.schema,
      loadGolden(entry.file.split("/")[0], entry.file.split("/").pop()),
    );
});

test("Agent Controller contract routes match registered callers in both directions", () => {
  const declared = new Set(
    collectContractRoutes(
      contractFile("contracts/agent-controller/control-contract.json"),
    ),
  );
  const problems = routeParityProblems(
    [...declared],
    callerRoutes("contracts/agent-controller/callers.json"),
  );
  assert.deepEqual(problems, [], problems.join("; "));
});

test("Runtime Controller contract routes match registered callers in both directions", () => {
  const problems = routeParityProblems(
    collectContractRoutes(
      contractFile("contracts/runtime-controller/control-contract.json"),
    ),
    callerRoutes("contracts/runtime-controller/callers.json"),
  );
  assert.deepEqual(problems, [], problems.join("; "));
});

test("Egress contract routes match registered callers in both directions", () => {
  const problems = routeParityProblems(
    collectContractRoutes(
      contractFile("contracts/egress/control-contract.json"),
    ),
    callerRoutes("contracts/egress/callers.json"),
  );
  assert.deepEqual(problems, [], problems.join("; "));
});

test("Identity methods are registered under their base path", () => {
  const identity = contractFile("contracts/identity/identity-contract.json");
  const declared = collectContractRoutes(
    identity.methods ?? {},
    identity.base_path ?? "",
  );
  const registered = new Set(callerRoutes("contracts/identity/callers.json"));
  const missing = declared.filter((route) => !registered.has(route));
  assert.deepEqual(missing, [], missing.join("; "));
});

test("selected ACP workspace and Runtime temporary routes are registered", () => {
  const acp = new Set(callerRoutes("contracts/agent-acp/callers.json"));
  const runtime = new Set(callerRoutes("contracts/runtime/callers.json"));
  for (const route of [
    "GET /rpc/agent-acp/workspace/sessions/{session_id}/execution",
    "GET /rpc/agent-acp/workspace/sessions/{session_id}/intents/{intent_id}",
    "GET /rpc/agent-acp/workspace/agents/{agent_id}/learning-status",
    "GET /rpc/agent-acp/workspace/agents/{agent_id}/learning-changes",
    "POST /rpc/agent-acp/list-execution-audits",
  ])
    assert.ok(acp.has(route), `ACP route missing: ${route}`);
  assert.ok(
    runtime.has("POST /internal/skill-temporary/{action}"),
    "Runtime temporary route missing",
  );
});

test("repository service-authentication and source-guard catalog passes", async () => {
  const result = await checkRepository();
  assert.deepEqual(result.errors, [], (result.errors ?? []).join("\n"));
});
