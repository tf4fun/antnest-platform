import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const readJSON = (path) => JSON.parse(read(path));

function builderCopies(dockerfile) {
  // Both builders copy repository-relative inputs under /src before cd'ing
  // into the crate. Inputs added after cargo test cannot supply that test.
  return [
    ...dockerfile
      .split(/\bcargo test\b/)[0]
      .matchAll(/^COPY (\S+) \.\/(\S+)\s*$/gm),
  ];
}

function builderContains(path, copies) {
  return copies.some(
    ([, source, destination]) =>
      (path === source || path.startsWith(`${source}/`)) &&
      `${destination}${path.slice(source.length)}` === path,
  );
}

function builderFixtureProblems(crate, dockerfile) {
  const fixtures = new Set();
  for (const name of readdirSync(
    new URL(`../../../${crate}/src/`, import.meta.url),
    { recursive: true },
  )) {
    if (!name.endsWith(".rs")) continue;
    const source = `${crate}/src/${name}`;
    const text = read(source);
    for (const match of text.matchAll(
      /concat!\(\s*env!\("CARGO_MANIFEST_DIR"\),\s*"([^"]+\.json)"/g,
    ))
      fixtures.add(posix.normalize(`${crate}/${match[1]}`));
    for (const match of text.matchAll(
      /include_(?:str|bytes)!\(\s*"([^"]+\.json)"/g,
    ))
      fixtures.add(posix.join(posix.dirname(source), match[1]));
  }
  assert(fixtures.size > 0, `${crate}: no literal JSON inputs discovered`);
  const copies = builderCopies(dockerfile);
  return [...fixtures]
    .filter((path) => {
      // Validate against real source inputs, not a second hand-written list.
      readJSON(path);
      return !builderContains(path, copies);
    })
    .map((path) => `builder is missing ${path}`)
    .sort();
}

function builderSchemaProblems(
  crate,
  loader,
  dockerfile = read(`${crate}/Dockerfile`),
) {
  const inventory = read(loader).match(/for dir in \[([^\]]+)\]/);
  assert(inventory, `${loader}: schema directory inventory missing`);
  const areas = [...inventory[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert(areas.length > 0);
  const copies = builderCopies(dockerfile);
  const documents = new Map();
  const problems = [];
  for (const area of areas) {
    for (const name of readdirSync(
      new URL(`../../../contracts/${area}/`, import.meta.url),
    )) {
      if (!name.endsWith(".schema.json")) continue;
      const path = `contracts/${area}/${name}`;
      const document = readJSON(path);
      documents.set(document.$id, document);
      if (!builderContains(path, copies))
        problems.push(`builder is missing ${path}`);
    }
  }
  const walk = (value, id) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      const url = new URL(value.$ref, id);
      url.hash = "";
      if (!documents.has(url.href))
        problems.push(`unregistered schema ${url.href}`);
    }
    for (const child of Object.values(value)) walk(child, id);
  };
  for (const [id, document] of documents) walk(document, id);
  return [...new Set(problems)].sort();
}

for (const [crate, loader] of [
  [
    "runtimes/antnest-runtime",
    "runtimes/antnest-runtime/src/http_route_contract_tests.rs",
  ],
  ["services/runtime-egress", "services/runtime-egress/tests/support/mod.rs"],
]) {
  test(`${crate} Docker builder contains the schema loader's complete offline input set`, () => {
    const dockerfile = read(`${crate}/Dockerfile`);
    assert.deepEqual(builderSchemaProblems(crate, loader, dockerfile), []);
    const removed = dockerfile.replace(/^COPY contracts\/common .*\n/m, "");
    assert(
      builderSchemaProblems(crate, loader, removed).includes(
        "builder is missing contracts/common/error.schema.json",
      ),
    );
    const misplaced = removed + "\nCOPY contracts/common ./contracts/common\n";
    assert(
      builderSchemaProblems(crate, loader, misplaced).includes(
        "builder is missing contracts/common/error.schema.json",
      ),
    );
    const wrongDestination = dockerfile.replace(
      "COPY contracts/common ./contracts/common",
      "COPY contracts/common ./contracts/elsewhere",
    );
    assert(
      builderSchemaProblems(crate, loader, wrongDestination).includes(
        "builder is missing contracts/common/error.schema.json",
      ),
    );
  });
}

test("Runtime Docker builder supplies JSON fixtures read by the real Rust sources", () => {
  const crate = "runtimes/antnest-runtime";
  const fixture =
    "tests/integration/skill-learning/maintenance-ticket-captures.json";
  const dockerfile = read(`${crate}/Dockerfile`);
  assert.deepEqual(builderFixtureProblems(crate, dockerfile), []);
  const copy = `COPY ${fixture} ./${fixture}`;
  const removed = dockerfile.replace(`${copy}\n`, "");
  for (const candidate of [
    removed,
    `${removed}\n${copy}\n`,
    dockerfile.replace(copy, `COPY ${fixture} ./tests/elsewhere.json`),
  ])
    assert(
      builderFixtureProblems(crate, candidate).includes(
        `builder is missing ${fixture}`,
      ),
      "missing, late, or misplaced fixture copies must reject",
    );
});

test("Runtime workflow follows the cross-language ticket capture on push and pull_request", () => {
  const workflow = read(".github/workflows/runtime.yml");
  assert.equal(
    workflow.match(
      /- tests\/integration\/skill-learning\/maintenance-ticket-captures\.json/g,
    )?.length,
    2,
  );
});

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
    "contracts/runtime-controller/control-api.ids-v2.schema.json",
  );
  assert.equal(
    schema.$id,
    "https://schemas.antnest.dev/runtime-controller/control-api.ids-v2.schema.json",
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
