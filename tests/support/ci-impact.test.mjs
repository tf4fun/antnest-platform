import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDependents,
  selectComponents,
  contractMarkers,
  extractReferences,
  impactedPaths,
  makefileGraph,
  makefileTargets,
  makeTargetsRun,
  ownership,
  validateOwnership,
} from "./ci-impact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function fixtureRoot(t, { map, contracts = {}, services = [] }) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-ci-impact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "tests/support"), { recursive: true });
  writeFileSync(
    join(directory, "tests/support/ci-ownership.json"),
    JSON.stringify(map),
  );
  for (const [name, callers] of Object.entries(contracts)) {
    mkdirSync(join(directory, "contracts", name), { recursive: true });
    if (callers !== null)
      writeFileSync(
        join(directory, "contracts", name, "callers.json"),
        JSON.stringify(callers),
      );
  }
  for (const service of services)
    mkdirSync(join(directory, "services", service), { recursive: true });
  mkdirSync(join(directory, "runtimes/antnest-runtime"), {
    recursive: true,
  });
  return directory;
}

test("the repository contract ownership registration is complete and consistent", () => {
  assert.deepEqual(validateOwnership(root), []);
});

test("every contracts directory must be registered with a nonempty known service list", (t) => {
  const unregistered = fixtureRoot(t, {
    map: { "agent-ui": ["agent-ui"] },
    contracts: { "agent-ui": null, ghost: null },
    services: ["agent-ui"],
  });
  assert(
    validateOwnership(unregistered).some((problem) =>
      problem.includes("contracts/ghost"),
    ),
    "unregistered contract directory must fail",
  );
  const empty = fixtureRoot(t, {
    map: { "agent-ui": [] },
    contracts: { "agent-ui": null },
    services: ["agent-ui"],
  });
  assert(
    validateOwnership(empty).some((problem) => problem.includes("agent-ui")),
    "an empty owner list must fail",
  );
  const unknown = fixtureRoot(t, {
    map: { "agent-ui": ["not-a-service"] },
    contracts: { "agent-ui": null },
    services: ["agent-ui"],
  });
  assert(
    validateOwnership(unknown).some((problem) =>
      problem.includes("not-a-service"),
    ),
    "an unknown service name must fail",
  );
});

test("the declared producer leads the list and matches callers.json", (t) => {
  const mismatch = fixtureRoot(t, {
    map: { "agent-ui": ["edge-gateway", "agent-ui"] },
    contracts: { "agent-ui": { service: "agent-ui", routes: {} } },
    services: ["agent-ui", "edge-gateway"],
  });
  assert(
    validateOwnership(mismatch).some((problem) => problem.includes("agent-ui")),
    "the producer must lead the declared consumers",
  );
});

test("internal callers must be covered while external callers are ignored", (t) => {
  const uncovered = fixtureRoot(t, {
    map: { "agent-ui": ["agent-ui"] },
    contracts: {
      "agent-ui": {
        service: "agent-ui",
        routes: {
          "GET /x": {
            callers: ["edge-gateway", "browser", "scim-client"],
          },
        },
      },
    },
    services: ["agent-ui", "edge-gateway"],
  });
  const problems = validateOwnership(uncovered);
  assert(
    problems.some((problem) => problem.includes("edge-gateway")),
    "an internal caller missing from the list must fail",
  );
  assert(
    !problems.some((problem) => problem.includes("browser")),
    "external callers never require registration",
  );
});

test("contract changes expand to their owning service markers", () => {
  assert.deepEqual(contractMarkers("contracts/agent-ui/schema.json"), [
    "services/agent-ui/",
    "services/edge-gateway/",
  ]);
  const runtime = contractMarkers("contracts/runtime/openapi.yaml");
  assert(runtime.includes("runtimes/antnest-runtime/"));
  assert(runtime.includes("services/agent-acp-service/"));
  assert.equal(
    contractMarkers("contracts/README.md"),
    null,
    "root contract documentation stays a global selection",
  );
  assert.throws(
    () => contractMarkers("contracts/ghost/schema.json"),
    /unknown contract/iu,
  );
});

test("literal references cover imports, require, URL and command paths", () => {
  const source = [
    'import a from "./a.mjs";',
    'import "./side-effect.mjs";',
    'const b = require("../shared/b.mjs");',
    'const c = await import("./c.mjs");',
    'const url = new URL("../../support/env.mjs", import.meta.url);',
    "node tests/support/ci-shard.mjs",
    "sh tests/e2e/e2e-stage2.sh",
  ].join("\n");
  const found = extractReferences(source, "tests/e2e/family/run.mjs");
  for (const expected of [
    "tests/e2e/family/a.mjs",
    "tests/e2e/family/side-effect.mjs",
    "tests/e2e/shared/b.mjs",
    "tests/e2e/family/c.mjs",
    "tests/support/env.mjs",
    "tests/support/ci-shard.mjs",
    "tests/e2e/e2e-stage2.sh",
  ])
    assert(found.has(expected), expected);
  assert.equal(
    extractReferences('import x from "yaml"', "tests/e2e/x.mjs").size,
    0,
    "package imports are not repository references",
  );
});

test("the reverse reference closure is transitive, terminal-aware and cycle safe", () => {
  const files = {
    "tests/support/helper.mjs": "",
    "tests/support/mid.mjs": 'import "./helper.mjs";',
    "tests/e2e/family/run.mjs":
      'import "../../support/mid.mjs"; import "../../support/helper.mjs";',
    "tests/e2e/family/extra.test.mjs": 'import "./run.mjs";',
  };
  const dependents = buildDependents(Object.keys(files), (path) => files[path]);
  assert.deepEqual([...dependents.get("tests/support/helper.mjs")].sort(), [
    "tests/e2e/family/run.mjs",
    "tests/support/mid.mjs",
  ]);
  const terminal = (path) => path === "tests/e2e/family/run.mjs";
  assert.deepEqual(
    impactedPaths("tests/support/helper.mjs", dependents, terminal),
    new Set(["tests/support/mid.mjs", "tests/e2e/family/run.mjs"]),
    "the closure records suite sources without expanding past them",
  );
  assert.deepEqual(
    impactedPaths("tests/support/helper.mjs", dependents),
    new Set([
      "tests/support/mid.mjs",
      "tests/e2e/family/run.mjs",
      "tests/e2e/family/extra.test.mjs",
    ]),
  );
  const cyclic = buildDependents(["a.mjs", "b.mjs"], (path) =>
    path === "a.mjs" ? 'import "./b.mjs";' : 'import "./a.mjs";',
  );
  assert.deepEqual(impactedPaths("a.mjs", cyclic), new Set(["b.mjs"]));
  const removed = buildDependents(["tests/e2e/family/run.mjs"], () => {
    return 'import "../../support/gone.mjs";';
  });
  assert.deepEqual(
    impactedPaths("tests/support/gone.mjs", removed, terminal),
    new Set(["tests/e2e/family/run.mjs"]),
    "a deleted helper still resolves through surviving literals",
  );
});

test("Makefile diffs name their changed targets or stay unproven", () => {
  const base = [
    "CACHE := .cache",
    "",
    "test-a:",
    "\tnode a.mjs",
    "",
    "test-b:",
    "\tnode b.mjs",
    "",
  ].join("\n");
  const head = base.replace("node a.mjs", "node a2.mjs");
  const diff = [
    "diff --git a/Makefile b/Makefile",
    "@@ -4 +4 @@",
    "-\tnode a.mjs",
    "+\tnode a2.mjs",
    "",
  ].join("\n");
  const git = (command, args) => {
    if (args[0] === "diff") return diff;
    if (args[0] === "show") return args[1] === "base:Makefile" ? base : head;
    throw new Error(`unexpected ${args}`);
  };
  assert.deepEqual(makefileTargets("base", "head", git), new Set(["test-a"]));
  const preamble = git;
  const preambleDiff = diff.replace("@@ -4 +4 @@", "@@ -1 +1 @@");
  assert.equal(
    makefileTargets("base", "head", (command, args) =>
      args[0] === "diff" ? preambleDiff : preamble(command, args),
    ),
    null,
    "a change outside named targets cannot prove ownership",
  );
});

test("blank, comment and .PHONY Makefile lines change no target", () => {
  const base = [
    "CACHE := .cache",
    "",
    ".PHONY: test-a",
    "# Runs a.",
    "test-a:",
    "\tnode a.mjs",
    "",
  ].join("\n");
  const head = base
    .replace(".PHONY: test-a", ".PHONY: test-a test-b")
    .replace("# Runs a.", "# Runs only a.");
  const diff = [
    "diff --git a/Makefile b/Makefile",
    "@@ -3,2 +3,2 @@",
    "-.PHONY: test-a",
    "-# Runs a.",
    "+.PHONY: test-a test-b",
    "+# Runs only a.",
    "",
  ].join("\n");
  const git = (command, args) => {
    if (args[0] === "diff") return diff;
    if (args[0] === "show") return args[1] === "base:Makefile" ? base : head;
    throw new Error(`unexpected ${args}`);
  };
  assert.deepEqual(makefileTargets("base", "head", git), new Set());
});

test("the Makefile graph follows prerequisites and recursive make calls", () => {
  const graph = makefileGraph(
    [
      "CACHE := .cache",
      ".PHONY: e2e-a build-b",
      "e2e-a: build-b $(CACHE)",
      "\tFLAG=1 $(MAKE) e2e-c",
      "\tnode a.mjs",
      "build-b:",
      "\tdocker build .",
      "e2e-c:",
      "\tmake build-d; node c.mjs",
      "build-d:",
      "\ttrue",
      "",
    ].join("\n"),
  );
  assert.deepEqual(graph.get("e2e-a"), new Set(["build-b", "e2e-c"]));
  assert.deepEqual(graph.get("e2e-c"), new Set(["build-d"]));
  assert.deepEqual(graph.get("build-b"), new Set());
  assert(!graph.has(".PHONY"));
  assert.deepEqual(
    makeTargetsRun(["make e2e-a"], [graph]),
    new Set(["e2e-a", "build-b", "e2e-c", "build-d"]),
  );
  assert.deepEqual(makeTargetsRun(["node x.mjs"], [graph]), new Set());
});

test("Makefile and system workflow changes select no service unit job", () => {
  assert.deepEqual(selectComponents(["Makefile"]), []);
  assert.deepEqual(selectComponents([".github/workflows/e2e.yml"]), []);
  assert.deepEqual(
    selectComponents([".github/workflows/integration.yml"]).length,
    selectComponents([], { all: true }).length,
    "the PR gate workflow still selects every unit job",
  );
});

test("the ownership check runs as a CI gate on this checkout", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/support/ci-impact.mjs", "--check"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("the repository ownership map feeds every declared consumer", () => {
  const map = ownership(root);
  assert.deepEqual(map["agent-ui"], ["agent-ui", "edge-gateway"]);
  assert(map["platform"].includes("identity-service"));
});

test("selectComponents maps docs, tests, contracts and helpers to owning services", () => {
  for (const file of ["README.md", "TODO.md", "docs/architecture/x.md"])
    assert.deepEqual(selectComponents([file]), [], file);
  assert.deepEqual(
    selectComponents(["services/identity-service/x.test.ts"]),
    ["identity-service"],
    "a service test-only change still selects its unit job",
  );
  assert.deepEqual(
    selectComponents([
      "tests/integration/go/identity-service/internal/x_test.go",
    ]),
    ["identity-service"],
  );
  for (const file of [
    "contracts/agent-ui/workspace-api.md",
    "contracts/agent-ui/callers.json",
  ])
    assert.deepEqual(
      selectComponents([file]),
      ["agent-ui", "edge-gateway"],
      file,
    );
  assert.deepEqual(
    selectComponents(["services/agent-acp-service/package-lock.json"]),
    ["agent-acp-service", "agent-ui"],
    "the ACP lockfile feeds the Agent UI tooling install",
  );
  assert.deepEqual(
    selectComponents([
      "tests/integration/skill-registry/package-rules-v1.json",
    ]),
    ["antnest-runtime", "skill-registry"],
    "the package-rules fixture feeds the Runtime workflow",
  );
  assert.deepEqual(
    selectComponents(["tests/support/helper.test.mjs"]),
    [],
    "a helper test selects no component",
  );
  const sources = {
    list: () => ["tests/integration/go/identity-service/internal/y_test.go"],
    read: () => 'import "tests/support/helper.mjs";',
  };
  assert.deepEqual(
    selectComponents(["tests/support/helper.mjs"], { sources }),
    ["identity-service"],
    "a production helper selects only its transitive service owners",
  );
  assert.deepEqual(
    selectComponents(["tests/support/orphan.mjs"], {
      sources: { list: () => [], read: () => "" },
    }).length,
    selectComponents([], { all: true }).length,
    "an unreferenced production helper conservatively selects all",
  );
});

test("selectComponents uses the repository reference graph by default", () => {
  const all = selectComponents([], { all: true });
  const via = selectComponents(["tests/support/check-markdown-links.mjs"]);
  assert.equal(via.length > 0, true, "default graph resolves");
  for (const name of via) assert(all.includes(name), name);
});
