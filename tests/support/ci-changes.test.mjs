import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bakeDefinition,
  changedFiles,
  images,
  matrix,
  matrixEntry,
  selectSuites,
  setups,
  suites,
} from "./ci-changes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ids = (selected) => selected.map((suite) => suite.id);

test("documentation-only changes select no suites", () => {
  assert.deepEqual(
    selectSuites([
      "README.md",
      "docs/stage-1-runtime.md",
      "services/runtime-egress/docs/operations.md",
      "runtimes/antnest-runtime/docs/mcp-contract.md",
      "LICENSE",
      ".github/ISSUE_TEMPLATE/bug.yml",
    ]),
    [],
  );
});

test("workflow, shared tooling, contract and Makefile changes select every suite", () => {
  for (const file of [
    ".github/workflows/integration.yml",
    "tests/support/dependencies.mjs",
    "contracts/runtime/README.md",
    "Makefile",
  ])
    assert.equal(selectSuites([file]).length, suites.length, file);
});

test("a service change selects only suites that exercise that service", () => {
  const selected = ids(selectSuites(["services/runtime-egress/src/main.rs"]));
  for (const id of [
    "egress-postgres",
    "auth-egress",
    "observation-retry",
    "shell-stage1",
    "shell-runtime-controller",
    "deployment-contracts",
    "gateway-security-headers",
  ])
    assert(selected.includes(id), id);
  for (const id of [
    "identity-postgres",
    "admin-console-browser",
    "auth-console",
    "skill-registry-discovery",
    "elicitation-sdk-probe",
  ])
    assert(!selected.includes(id), id);
});

test("test sources select the suites that run them", () => {
  assert.deepEqual(
    ids(selectSuites(["tests/integration/admin-console/catalog-browser.mjs"])),
    ["admin-console-browser", "deployment-contracts", "skill-registry-console"],
  );
  assert.deepEqual(
    ids(
      selectSuites([
        "tests/integration/antnest-runtime/sdk-probes/elicitation/tests/probe.rs",
      ]),
    ),
    ["deployment-contracts", "elicitation-sdk-probe"],
  );
});

test("an explicit full run selects every suite without any changes", () => {
  assert.equal(selectSuites([], { all: true }).length, suites.length);
});

test("the catalog is unique and refers to existing entry points", () => {
  assert.equal(new Set(ids(suites)).size, suites.length);
  assert.equal(new Set(suites.map((suite) => suite.name)).size, suites.length);
  const targets = new Set(
    [
      ...readFileSync(resolve(root, "Makefile"), "utf8").matchAll(
        /^([\w.-]+):/gmu,
      ),
    ].map((match) => match[1]),
  );
  for (const suite of suites) {
    assert(["a", "b"].includes(suite.tier), suite.id);
    assert(suite.paths.length > 0 && suite.run.length > 0, suite.id);
    for (const setup of suite.setup) assert(setups.includes(setup), setup);
    for (const image of suite.images ?? [])
      assert(Object.hasOwn(images, image), image);
    for (const command of suite.run) {
      const make = /^make ([\w.-]+)$/u.exec(command);
      if (make) assert(targets.has(make[1]), command);
      const node = /^node (\S+)/u.exec(command);
      if (node) assert(existsSync(resolve(root, node[1])), command);
    }
  }
  for (const dockerfile of Object.values(images))
    assert(existsSync(resolve(root, dockerfile)), dockerfile);
});

test("matrix entries carry the tier and scalar setup flags", () => {
  const { include } = matrix(suites);
  assert.equal(include.length, suites.length);
  assert.deepEqual(
    new Set(include.map((row) => row.tier)),
    new Set(["A", "B"]),
  );
  const entry = matrixEntry(
    suites.find((suite) => suite.id === "observation-retry"),
  );
  assert.equal(entry.setup_acp, true);
  assert.equal(entry.setup_go_offline, false);
  assert.equal(
    entry.images,
    "antnest-runtime,agent-acp-service,runtime-egress",
  );
  assert.equal(entry.pull, "postgres:17.11-bookworm");
  assert.equal(entry.run, "make e2e-runtime-controller-observation-retry");
  for (const row of include)
    for (const value of Object.values(row))
      assert(["string", "boolean"].includes(typeof value));
  assert.deepEqual(matrix([]), { include: [] });
});

test("bake definitions tag local images and read the image workflow cache", () => {
  const definition = bakeDefinition(
    ["antnest-runtime", "runtime-egress"],
    "/workspace",
  );
  assert.deepEqual(definition.group.default.targets, [
    "antnest-runtime",
    "runtime-egress",
  ]);
  assert.deepEqual(definition.target["runtime-egress"], {
    context: "/workspace",
    dockerfile: "services/runtime-egress/Dockerfile",
    platforms: ["linux/amd64"],
    tags: ["antnest/runtime-egress:local"],
    "cache-from": ["type=gha,scope=antnest-runtime-egress"],
  });
  assert.deepEqual(definition.target["antnest-runtime"]["cache-from"], [
    "type=gha,scope=antnest-runtime",
  ]);
  assert.throws(() => bakeDefinition(["unknown"]), /unknown image/u);
});

test("changed files come from a rename-free merge-base diff", () => {
  let call;
  const files = changedFiles("base", "head", (...args) => {
    call = args;
    return "a.txt\0dir/b c.mjs\0";
  });
  assert.deepEqual(files, ["a.txt", "dir/b c.mjs"]);
  assert.deepEqual(call[1], [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "base...head",
  ]);
});
