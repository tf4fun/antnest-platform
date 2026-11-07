import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const readJSON = (path) => JSON.parse(read(path));

function testRepoRecipe() {
  const lines = read("Makefile").split("\n");
  const start = lines.indexOf("test-repo:");
  assert.notEqual(start, -1);
  const recipe = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") continue;
    if (!line.startsWith("\t")) break;
    recipe.push(line);
  }
  return recipe.join("\n");
}

test("root test-repo recipe includes all runtime-plane contract gates", () => {
  const recipe = testRepoRecipe();
  assert(
    recipe.includes("tests/integration/runtime-tools/*.test.mjs"),
    "runtime-tools glob missing",
  );
  for (const gate of [
    "tests/integration/runtime-egress/route-body-contract.test.mjs",
    "tests/integration/runtime-controller/route-body-contract.test.mjs",
  ]) {
    assert(recipe.includes(gate), `${gate} not in test-repo recipe`);
  }
});

test("root CI runs the test-repo gate", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert(/run:\s*make test-repo\b/.test(workflow));
});

test("contract-area CI ownership maps to affected services", () => {
  const ownership = readJSON("tests/support/ci-ownership.json");
  assert.deepEqual(ownership.egress, [
    "runtime-egress",
    "agent-controller",
    "runtime-controller",
  ]);
  assert.deepEqual(ownership.runtime, [
    "antnest-runtime",
    "agent-acp-service",
    "runtime-controller",
    "runtime-egress",
  ]);
  assert.deepEqual(ownership["runtime-controller"], [
    "runtime-controller",
    "agent-controller",
    "agent-acp-service",
  ]);
});

test("workflows filter the canonical RC contract path on push and pull_request", () => {
  for (const workflow of [
    "runtime-controller",
    "agent-controller",
    "agent-acp-service",
  ]) {
    const text = read(`.github/workflows/${workflow}.yml`);
    const matches = text.match(/- contracts\/runtime-controller\/\*\*/g) ?? [];
    assert.equal(matches.length, 2, `${workflow} path filters`);
  }
});

test("runtime-controller contract is canonical and self-consistent", () => {
  assert(
    existsSync(
      new URL(
        "../../../contracts/runtime-controller/control-contract.json",
        import.meta.url,
      ),
    ),
  );
  const schema = readJSON(
    "contracts/runtime-controller/control-api.schema.json",
  );
  assert.equal(
    schema.$id,
    "https://schemas.antnest.dev/runtime-controller/control-api.schema.json",
  );
  for (const legacy of [
    "services/runtime-controller/api/control-contract.json",
    "services/runtime-controller/api/control-api.schema.json",
    "services/runtime-controller/api/callers.json",
  ])
    assert(!existsSync(new URL(`../../../${legacy}`, import.meta.url)), legacy);
});

test("golden manifest pairs runtime-plane producers with the AC consumer", () => {
  const manifest = readJSON("contracts/golden-manifest.json");
  const pairs = new Map(manifest.map((entry) => [entry.file, entry]));
  for (const file of [
    "egress/examples/network.closed.json",
    "egress/examples/assignment.current.json",
    "egress/examples/policy.v1.json",
    "egress/examples/policy-metadata.v1.json",
  ]) {
    const entry = pairs.get(file);
    assert(entry !== undefined, `${file} missing`);
    assert.equal(entry.producer, "runtime-egress");
    assert(entry.consumers.includes("agent-controller"), file);
    assert(entry.schema.startsWith("egress/"), file);
  }
  for (const file of [
    "runtime/examples/rc-inspection.healthy.json",
    "runtime/examples/rc-observations.current.json",
    "runtime/examples/rc-observations.n-1.json",
  ]) {
    const entry = pairs.get(file);
    assert(entry !== undefined, `${file} missing`);
    assert.equal(entry.producer, "runtime-controller");
    assert(entry.consumers.includes("agent-controller"), file);
    assert(
      entry.schema.startsWith("runtime-controller/"),
      `${file} schema must point at the canonical area`,
    );
    assert(!entry.schema.startsWith("services/"), file);
  }
});
