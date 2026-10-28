import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const { parse } = require("yaml");
const workflow = parse(
  readFileSync(
    new URL("../../.github/workflows/integration.yml", import.meta.url),
    "utf8",
  ),
);
const gate = workflow.jobs.integration;
const unitServices = [
  "admin-console",
  "agent-acp-service",
  "agent-controller",
  "agent-ui",
  "antnest-runtime",
  "edge-gateway",
  "identity-service",
  "runtime-controller",
  "runtime-egress",
  "skill-registry",
];
const unitResults = (result = "skipped") =>
  JSON.stringify(
    Object.fromEntries(
      unitServices.map((name) => [`unit-${name}`, { result }]),
    ),
  );
const selected = {
  CHANGES: "success",
  MODE: "component",
  EVENT: "pull_request",
  DRAFT: "false",
  IMAGES: "skipped",
  BUILDING: "0",
  SUITE: "skipped",
  PLAIN: "0",
  IMAGE_SUITE: "skipped",
  IMAGED: "0",
  SERVICES: "[]",
  UNIT_RESULTS: unitResults(),
};
const check = (changes = {}) =>
  spawnSync("bash", ["-e", "-o", "pipefail", "-c", gate.steps[0].run], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH, ...selected, ...changes },
  });

test("all component tiers are dependencies of the required integration result", () => {
  assert.deepEqual(
    new Set(gate.needs),
    new Set([
      "changes",
      "images",
      "suite",
      "image-suite",
      "unit-admin-console",
      "unit-agent-acp-service",
      "unit-agent-controller",
      "unit-agent-ui",
      "unit-antnest-runtime",
      "unit-edge-gateway",
      "unit-identity-service",
      "unit-runtime-controller",
      "unit-runtime-egress",
      "unit-skill-registry",
    ]),
  );
  assert.equal(gate.if, "always()");
  const env = gate.steps[0].env;
  assert.equal(env.MODE, "${{ needs.changes.outputs.mode }}");
  assert.equal(env.SUITE, "${{ needs.suite.result }}");
  assert.equal(env.IMAGE_SUITE, "${{ needs.image-suite.result }}");
  for (const key of Object.keys(env))
    assert(
      !key.startsWith("OPTIONAL"),
      `${key} is a Tier C variable; the component gate has none`,
    );
});

test("a component gate admits exactly the selected matrices and nothing else", () => {
  assert.equal(check().status, 0);
  for (const [count, result] of [
    ["BUILDING", "IMAGES"],
    ["PLAIN", "SUITE"],
    ["IMAGED", "IMAGE_SUITE"],
  ]) {
    for (const value of ["", "-1", "1x", "unknown"])
      assert.notEqual(
        check({ [count]: value, [result]: "success" }).status,
        0,
        `${count}=${value}`,
      );
    assert.notEqual(
      check({ [count]: "1", [result]: "skipped" }).status,
      0,
      result,
    );
    for (const status of ["failure", "cancelled"])
      assert.notEqual(
        check({ [count]: "0", [result]: status }).status,
        0,
        `${result}=${status}`,
      );
  }
});

test("the component gate carries no Tier C or priority E2E variables", () => {
  for (const job of ["optional-suite", "priority-suite", "priority-images"])
    assert(!Object.hasOwn(workflow.jobs, job), `${job} left the gate`);
  const env = gate.steps[0].env;
  for (const key of Object.keys(env))
    assert(!/OPTIONAL|PRIORITY/u.test(key), `${key} is E2E, not component`);
});

test("selected unit checks block admission while E2E results cannot", () => {
  const service = unitServices[0];
  const chosen = { SERVICES: JSON.stringify([service]) };
  chosen.UNIT_RESULTS = JSON.stringify(
    Object.fromEntries(
      unitServices.map((name) => [
        `unit-${name}`,
        { result: name === service ? "success" : "skipped" },
      ]),
    ),
  );
  assert.equal(check(chosen).status, 0);
  for (const result of ["failure", "cancelled", "skipped", "", "unknown"])
    assert.notEqual(
      check({
        ...chosen,
        UNIT_RESULTS: JSON.stringify(
          Object.fromEntries(
            unitServices.map((name) => [
              `unit-${name}`,
              { result: name === service ? result : "skipped" },
            ]),
          ),
        ),
      }).status,
      0,
      `unit ${service}=${result}`,
    );
  assert.notEqual(
    check({ ...chosen, UNIT_RESULTS: "{}" }).status,
    0,
    "missing unit results",
  );
  assert.notEqual(
    check({ ...chosen, SERVICES: `["${service}","${service}"]` }).status,
    0,
    "duplicate selection",
  );
  assert.notEqual(
    check({ ...chosen, SERVICES: '["ghost"]' }).status,
    0,
    "unknown selection",
  );
});

test("cancelled workflows and failed selection never produce a successful gate", () => {
  for (const CHANGES of ["failure", "cancelled", "skipped", ""])
    assert.notEqual(check({ CHANGES }).status, 0, CHANGES);
  const cancellation = gate.steps.at(-1);
  assert.equal(cancellation.if, "cancelled()");
  const cancelled = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", cancellation.run],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.notEqual(
    cancelled.status,
    0,
    "cancellation fails even after a successful docs-only gate",
  );
  for (const MODE of ["", "unknown", "ignored", "full"])
    assert.notEqual(check({ MODE }).status, 0, MODE);
  assert.notEqual(check({ MODE: "light", DRAFT: "false" }).status, 0);
  assert.equal(check({ MODE: "light", DRAFT: "true" }).status, 0);
});

test("only normal component runs use the required name, even when selection fails early", () => {
  const expression = gate.name.slice(3, -2).trim();
  const name = ({ event = "pull_request", draft = false, suites = "" } = {}) =>
    runInNewContext(expression, {
      github: { event_name: event, event: { pull_request: { draft } } },
      inputs: { suites },
    });
  assert.equal(name(), "Integration checks");
  assert.equal(name({ event: "push" }), "Integration checks");
  assert.equal(name({ event: "workflow_dispatch" }), "Integration checks");
  assert.equal(
    name({ event: "workflow_dispatch", suites: "egress-postgres" }),
    "Integration checks (partial)",
  );
  assert.equal(name({ draft: true }), "Integration checks (not run)");
});

test("uploaded evidence excludes raw component logs and private inputs but retains outcomes and timings", () => {
  const suite = parse(
    readFileSync(
      new URL("../../.github/workflows/_suite.yml", import.meta.url),
      "utf8",
    ),
  );
  const upload = suite.jobs.run.steps.find(
    ({ name }) => name === "Upload evidence",
  );
  assert.equal(upload.if, "always()");
  const excluded = upload.with.path
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1));
  const filtered = (path) =>
    excluded.some((pattern) => matchesGlob(path, pattern));
  for (const path of [
    "artifacts/verification/antnest-deployment-1234/deployment.env",
    "artifacts/verification/antnest-deployment-1234/generate-deployment-env.log",
    "artifacts/verification/run/credentials/tokens/service",
    "artifacts/verification/run/private.key",
    "artifacts/verification/run/private.pem",
    "artifacts/verification/run/failure.private.txt",
    "artifacts/verification/run/failure.private.json",
    "artifacts/verification/run/client-private/round-1.json",
    "artifacts/verification/ci-shards/shard-123/first.log",
    "artifacts/verification/go-integration/first.log",
    "artifacts/verification/dependencies/first.log",
  ])
    assert(filtered(path), `${path} contains fixture credentials`);
  for (const path of [
    "artifacts/verification/ci-shards/shard-123/results.json",
    "artifacts/verification/run/result.json",
  ])
    assert(!filtered(path), `${path} is required verification evidence`);
});

test("Go service failures retain lint and integration diagnostics without private inputs", () => {
  const service = parse(
    readFileSync(
      new URL("../../.github/workflows/_go-service.yml", import.meta.url),
      "utf8",
    ),
  );
  const upload = service.jobs.check.steps.find(
    ({ name }) => name === "Upload Go integration evidence",
  );
  assert.equal(upload.if, "always()");
  const patterns = upload.with.path.split(/\r?\n/u).filter(Boolean);
  const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const retained = (path) =>
    includes.some((pattern) => matchesGlob(path, pattern)) &&
    !excludes.some((pattern) => matchesGlob(path, pattern));
  for (const directory of ["go-lint", "go-integration"]) {
    const root = `artifacts/verification/${directory}`;
    for (const name of ["failed-command.log", "failed-command.result.json"])
      assert(
        retained(`${root}/${name}`),
        `missing failure evidence: ${directory}/${name}`,
      );
    for (const name of [
      "failed-command.private.log",
      "failed-command.private.result.json",
      "go-overlay-identity-service.json",
    ])
      assert(
        !retained(`${root}/${name}`),
        `private input selected: ${directory}/${name}`,
      );
  }
});
