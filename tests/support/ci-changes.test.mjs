import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bakeDefinition,
  changedFiles,
  dockerfileSources,
  imageDigest,
  imageExists,
  imageReference,
  images,
  imageSpec,
  listTree,
  matrices,
  matrix,
  matrixEntry,
  outsideCI,
  resolveImages,
  selectSuites,
  setups,
  shards,
  suiteImages,
  suites,
} from "./ci-changes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ids = (selected) => selected.map((suite) => suite.id);
const enabled = suites.filter((suite) => !suite.disabled);

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
    ".github/workflows/_suite.yml",
    "tests/support/dependencies.mjs",
    "contracts/runtime/README.md",
    "Makefile",
  ])
    assert.equal(selectSuites([file]).length, enabled.length, file);
});

test("a service change selects only suites that exercise that service", () => {
  const selected = ids(selectSuites(["services/runtime-egress/src/main.rs"]));
  for (const id of [
    "egress-postgres",
    "shell-runtime-controller",
    "deployment-contracts",
    "gateway-security-headers",
  ])
    assert(selected.includes(id), id);
  for (const id of [
    "auth-identity",
    "admin-console-browser",
    "auth-console",
    "skill-registry-discovery",
    "elicitation-sdk-probe",
  ])
    assert(!selected.includes(id), id);
});

test("shared Runtime tunnel changes select both transport owners and their integration", () => {
  const selected = ids(selectSuites(["modules/runtime-tunnel/src/lib.rs"]));
  for (const id of [
    "auth-runtime",
    "auth-egress",
    "egress-postgres",
    "shell-stage1",
    "skill-learning-runtime",
    "skill-temporary-runtime",
  ])
    assert(selected.includes(id), id);
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

test("managed MCP and deployment wiring runners select their suites", () => {
  const required = (selected) =>
    ids(selected.filter((suite) => suite.tier !== "c"));
  assert.deepEqual(
    required(selectSuites(["tests/e2e/managed-mcp/model.mjs"])),
    [
      "deployment-contracts",
      "managed-mcp-secrets-v1",
      "managed-mcp-secrets-v2",
    ],
  );
  assert(
    ids(
      selectSuites(["tests/integration/deployment/compose-runtime-docker.mjs"]),
    ).includes("deployment-wiring"),
  );
});

test("an explicit full run selects every enabled suite without any changes", () => {
  assert.deepEqual(selectSuites([], { all: true }), enabled);
});

test("a manual run can name the suites it runs", () => {
  assert.deepEqual(
    ids(selectSuites([], { only: ["c-acp-session", "egress-postgres"] })),
    ["egress-postgres", "c-acp-session"],
  );
  assert.throws(
    () => selectSuites([], { only: ["egress-postgres", "missing"] }),
    /unknown suite missing/u,
  );
});

test("disabled suites name their breakage and are never selected", () => {
  const disabled = suites.filter((suite) => suite.disabled);
  for (const suite of disabled) {
    assert.equal(typeof suite.disabled, "string");
    assert(!selectSuites(["Makefile"], { all: true }).includes(suite));
  }
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
    assert(["a", "b", "c"].includes(suite.tier), suite.id);
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
  for (const name of Object.keys(images)) {
    const { dockerfile, contexts = {} } = imageSpec(name);
    assert(existsSync(resolve(root, dockerfile)), dockerfile);
    for (const { image } of Object.values(contexts))
      assert(typeof images[image] === "string", `${name} layers on ${image}`);
  }
});

test("platform targets kept out of CI exist, run nowhere and name their issue", () => {
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  const commands = suites.flatMap((suite) => suite.run).join("\n");
  for (const [target, issue] of Object.entries(outsideCI)) {
    assert.match(makefile, new RegExp(`^${target}:`, "mu"), target);
    assert(!commands.includes(target), target);
    assert(!ids(suites).includes(target.replace(/^e2e-/u, "c-")), target);
    assert(Number.isInteger(issue) && issue > 0, target);
  }
});

test("every suite belongs to exactly one shard of its own tier", () => {
  const members = shards.flatMap((shard) => shard.suites);
  assert.equal(new Set(members).size, members.length);
  assert.deepEqual([...members].sort(), ids(suites).sort());
  assert.equal(new Set(shards.map((shard) => shard.id)).size, shards.length);
  for (const shard of shards) {
    assert(shard.suites.length > 0, shard.id);
    const tiers = new Set(
      shard.suites.map((id) => suites.find((suite) => suite.id === id).tier),
    );
    assert.equal(tiers.size, 1, shard.id);
    assert(shard.id.startsWith(`${[...tiers][0]}-`), shard.id);
  }
  assert(shards.filter((shard) => shard.id.startsWith("c-")).length <= 12);
});

test("suite entries carry the tier and scalar setup flags", () => {
  const entry = matrixEntry(
    suites.find((suite) => suite.id === "auth-runtime-controller"),
  );
  assert.equal(entry.tier, "B");
  assert.equal(entry.setup_go, false);
  assert.equal(entry.setup_chromium, false);
  assert.equal(entry.images, "antnest-runtime");
  assert.equal(
    entry.pull,
    "postgres:17.11-bookworm node:24.21.0-bookworm-slim",
  );
  assert.equal(
    entry.run,
    "node tests/e2e/service-authentication/runtime-controller/run.mjs",
  );
});

test("shard entries run their selected suites in shard order with merged setup", () => {
  const { include } = matrix(suites);
  assert.equal(include.length, shards.length);
  assert.deepEqual(
    new Set(include.map((row) => row.tier)),
    new Set(["A", "B", "C"]),
  );
  for (const row of include)
    for (const value of Object.values(row))
      assert(["string", "boolean"].includes(typeof value));
  const pick = (...names) => suites.filter((suite) => names.includes(suite.id));
  const [postgres] = matrix(
    pick("agent-controller-postgres", "egress-postgres", "auth-console"),
  ).include.filter((row) => row.id === "a-postgres");
  assert.deepEqual(
    JSON.parse(postgres.suites).map(({ id }) => id),
    ["egress-postgres", "agent-controller-postgres"],
  );
  assert.equal(postgres.images, "temporal");
  assert.equal(postgres.setup_go, true);
  assert.equal(postgres.setup_rust, true);
  assert.equal(postgres.setup_chromium, false);
  const [identity] = matrix(pick("c-identity-access")).include;
  assert.deepEqual(JSON.parse(identity.suites), [
    {
      id: "c-identity-access",
      name: "Stage 3a: identity-access",
      run: "ANTNEST_E2E_IDENTITY_ACCESS=true sh tests/e2e/e2e-stage3a.sh",
      strict: true,
    },
  ]);
  assert.deepEqual(matrix([]), { include: [] });
});

test("required shards split by image need; tier C forms its own matrix", () => {
  const { plain, imaged, optional } = matrices(suites);
  assert.equal(
    plain.include.length + imaged.include.length + optional.include.length,
    shards.length,
  );
  assert(plain.include.every((row) => row.images === "" && row.tier !== "C"));
  assert(imaged.include.every((row) => row.images !== "" && row.tier !== "C"));
  assert(optional.include.every((row) => row.tier === "C"));
  assert(plain.include.some((row) => row.id === "a-browser"));
  assert(imaged.include.some((row) => row.id === "b-auth"));
  assert(optional.include.some((row) => row.id === "c-acp"));
  assert.deepEqual(matrices([]), {
    plain: { include: [] },
    imaged: { include: [] },
    optional: { include: [] },
  });
});

test("tier C platform scenarios get every local image and no rebuilding target", () => {
  const tierC = suites.filter((suite) => suite.tier === "c");
  assert.equal(tierC.length, 45);
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  const primary = Object.keys(images).filter(
    (name) => typeof images[name] === "string",
  );
  const variants = {
    "c-tool-permissions": ["antnest-runtime-managed"],
    "c-tool-progress": ["antnest-runtime-managed"],
    ...Object.fromEntries(
      tierC
        .filter((suite) => suite.id.startsWith("c-skill-learning-install-"))
        .map((suite) => [suite.id, ["antnest-runtime-skill-gate"]]),
    ),
  };
  assert.equal(Object.keys(variants).length, 8);
  for (const suite of tierC) {
    assert.deepEqual(
      suite.images,
      [...primary, ...(variants[suite.id] ?? [])].sort(),
      suite.id,
    );
    for (const command of suite.run) {
      const make = /^make ([\w.-]+)$/u.exec(command);
      if (!make) continue;
      const recipe = new RegExp(
        `^${make[1]}:(?<deps>.*)\\n(?<body>(?:\\t.*\\n)*)`,
        "mu",
      ).exec(makefile);
      assert(recipe, suite.id);
      assert.equal(
        recipe.groups.deps.trim(),
        "",
        `${suite.id} has prerequisites`,
      );
      if (make[1] === "docker-build-managed-runtime") {
        // Test-only fixture image layered on the provided Runtime image.
        assert.doesNotMatch(
          recipe.groups.body,
          /-t antnest\/antnest-runtime:local/u,
        );
        continue;
      }
      assert.doesNotMatch(recipe.groups.body, /docker (?:compose .*)?build/u);
    }
  }
});

test("required suites declare every image their runners derive candidates from", () => {
  const primary = Object.keys(images)
    .filter((name) => typeof images[name] === "string")
    .sort();
  const expected = {
    "auth-runtime": [
      "antnest-runtime",
      "antnest-runtime-fixture",
      "antnest-runtime-skill-gate",
    ],
    "deployment-wiring": primary,
    "gateway-security-headers": primary,
    "agent-ui-receipt": primary,
    "managed-mcp-secrets-v1": [
      ...primary,
      "antnest-runtime-fixture",
      "antnest-runtime-managed",
    ].sort(),
    "managed-mcp-secrets-v2": [
      ...primary,
      "antnest-runtime-fixture",
      "antnest-runtime-managed",
    ].sort(),
    "observation-retry": [
      "agent-acp-service",
      "antnest-runtime",
      "runtime-controller",
      "runtime-egress",
    ],
    "shell-stage1": ["antnest-runtime", "runtime-egress"],
    "shell-runtime-controller": [
      "antnest-runtime",
      "runtime-controller",
      "runtime-egress",
    ],
    "skill-learning-runtime": [
      "antnest-runtime",
      "antnest-runtime-fixture",
      "antnest-runtime-skill-gate",
    ],
    "skill-registry-console": ["admin-console", "skill-registry"],
    "skill-registry-discovery": ["skill-registry"],
    "skill-temporary-runtime": ["antnest-runtime"],
  };
  for (const [id, names] of Object.entries(expected))
    assert.deepEqual(suites.find((suite) => suite.id === id).images, names, id);
});

test("tier C managed MCP scenarios build their fixture image first", () => {
  const scripts = resolve(root, "tests/e2e");
  for (const id of ["c-tool-permissions", "c-tool-progress"]) {
    const suite = suites.find((item) => item.id === id);
    assert.equal(suite.run[0], "make docker-build-managed-runtime");
    assert.match(
      readFileSync(
        resolve(scripts, `${id.replace(/^c-/u, "e2e-")}.sh`),
        "utf8",
      ),
      /antnest\/antnest-runtime:managed-integration/u,
    );
  }
});

test("tier C Stage 3a profiles keep their strict exit 2 by running the make recipe directly", () => {
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  for (const name of [
    "acp-closeout",
    "acp-session",
    "agent-access",
    "identity-access",
    "identity-core",
    "organization-display",
    "tool-permissions",
    "tool-progress",
  ]) {
    const suite = suites.find((item) => item.id === `c-${name}`);
    const recipe = new RegExp(`^e2e-${name}:\\n\\t(.*)$`, "mu").exec(makefile);
    assert(recipe, name);
    assert.equal(suite.run.at(-1), recipe[1], name);
    assert.deepEqual(
      suite.run.slice(0, -1),
      name.startsWith("tool-") ? ["make docker-build-managed-runtime"] : [],
      name,
    );
    assert.equal(suite.strict, true, name);
  }
});

test("tier C organization display installs the Agent UI browser client", () => {
  const suite = suites.find((item) => item.id === "c-organization-display");
  assert.deepEqual(suite.setup, ["agent-ui-web", "chromium"]);
});

test("foundation runners report strict-only findings through exit 2", () => {
  const foundation = {
    "c-lifecycle-loss": "lifecycle-closeout/run.mjs loss",
    "c-lifecycle-restore": "lifecycle-closeout/run.mjs restore",
    "c-lifecycle-shutdown": "lifecycle-closeout/run.mjs shutdown",
    "c-stage4-skill-restore": "lifecycle-closeout/run.mjs skill-restore",
    "c-workspace": "workspace-closeout/run.mjs",
    "c-workspace-browser": "workspace-closeout/browser-run.mjs",
  };
  for (const suite of suites) {
    const entry = matrixEntry(suite);
    if (!Object.hasOwn(foundation, suite.id)) {
      if (!/ sh tests\/e2e\/e2e-stage3a\.sh$/u.test(entry.run))
        assert.equal(entry.strict_exit, false, suite.id);
      continue;
    }
    assert.equal(entry.strict_exit, true, suite.id);
    // make reports every failed recipe as 2, which would hide the runner's code.
    assert.equal(entry.run, `node tests/e2e/${foundation[suite.id]}`);
  }
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

test("Runtime test variants build a stage or layer on Runtime build stages", () => {
  const gate = bakeDefinition(["antnest-runtime-skill-gate"], "/workspace");
  assert.deepEqual(gate.group.default.targets, ["antnest-runtime-skill-gate"]);
  assert.deepEqual(gate.target["antnest-runtime-skill-gate"], {
    context: "/workspace",
    dockerfile: "runtimes/antnest-runtime/Dockerfile",
    platforms: ["linux/amd64"],
    tags: ["antnest/antnest-runtime-skill-gate:local"],
    target: "e2e",
    args: { ANTNEST_RUNTIME_FEATURES: "skill-maintenance-e2e-gate" },
    "cache-from": [
      "type=gha,scope=antnest-runtime-skill-gate",
      "type=gha,scope=antnest-runtime",
    ],
    // No image workflow owns a variant's cache scope.
    "cache-to": ["type=gha,mode=max,scope=antnest-runtime-skill-gate"],
  });

  const managed = bakeDefinition(
    ["antnest-runtime-managed", "antnest-runtime-fixture"],
    "/workspace",
  );
  assert.deepEqual(managed.group.default.targets, [
    "antnest-runtime-managed",
    "antnest-runtime-fixture",
  ]);
  assert.deepEqual(managed.target["antnest-runtime-managed"].contexts, {
    "antnest/antnest-runtime:managed-build":
      "target:base-antnest-runtime-build",
    "antnest/antnest-runtime:local": "target:base-antnest-runtime",
  });
  assert.deepEqual(managed.target["antnest-runtime-fixture"].contexts, {
    "antnest/antnest-runtime:managed-build":
      "target:base-antnest-runtime-build",
  });
  assert.deepEqual(managed.target["base-antnest-runtime-build"], {
    context: "/workspace",
    dockerfile: "runtimes/antnest-runtime/Dockerfile",
    platforms: ["linux/amd64"],
    target: "build",
    "cache-from": ["type=gha,scope=antnest-runtime"],
  });
  assert.deepEqual(managed.target["base-antnest-runtime"], {
    context: "/workspace",
    dockerfile: "runtimes/antnest-runtime/Dockerfile",
    platforms: ["linux/amd64"],
    "cache-from": ["type=gha,scope=antnest-runtime"],
  });
  assert.deepEqual(managed.target["antnest-runtime-managed"]["cache-from"], [
    "type=gha,scope=antnest-runtime-managed",
    "type=gha,scope=antnest-runtime",
  ]);
});

test("variant contexts replace exactly the base images their Dockerfile names", () => {
  for (const [name, file] of [
    ["antnest-runtime-managed", "tests/e2e/managed-mcp/Dockerfile"],
    ["antnest-runtime-fixture", "tests/e2e/managed-mcp/fixture.Dockerfile"],
  ]) {
    const text = readFileSync(resolve(root, file), "utf8");
    const defaults = [...text.matchAll(/^ARG \w+=(\S+)$/gmu)].map(
      ([, value]) => value,
    );
    assert.deepEqual(
      Object.keys(bakeDefinition([name]).target[name].contexts).sort(),
      defaults.sort(),
      name,
    );
  }
});

test("Dockerfile sources skip stage copies, flags and comments", () => {
  assert.deepEqual(
    dockerfileSources(
      [
        "# COPY ignored ./comment",
        "FROM node AS build",
        "COPY services/a/package.json \\",
        "  services/a/package-lock.json ./",
        "COPY --chown=node:node ./services/a/src/ ./src",
        "COPY --from=build /workspace/dist ./dist",
        "ADD --chmod=0555 scripts/run.sh /run.sh",
        "copy . /context",
        "RUN npm ci",
      ].join("\n"),
    ),
    [
      "services/a/package.json",
      "services/a/package-lock.json",
      "services/a/src",
      "scripts/run.sh",
      "",
    ],
  );
});

const blobs = new Map([
  [
    "dockerfile-1",
    "FROM scratch\nCOPY services/a ./\nCOPY web/package*.json ./\n",
  ],
  ["dockerfile-2", "FROM scratch\nCOPY services/a ./\nCOPY missing ./\n"],
  [
    "dockerfile-3",
    "FROM scratch\nCOPY services/a ./\nCOPY web/package*.json ./\nUSER 1\n",
  ],
]);
const readBlob = (object) => blobs.get(object) ?? "";
const tree = (entries) =>
  new Map(
    Object.entries({
      ".dockerignore": "ignore-1",
      "services/runtime-egress/Dockerfile": "dockerfile-1",
      "services/a/main.go": "main-1",
      "services/ab/main.go": "other-1",
      "web/package.json": "package-1",
      "web/src/index.ts": "source-1",
      "README.md": "readme-1",
      ...entries,
    }).map(([path, object]) => [path, { mode: "100644", object }]),
  );

test("image digests change only with the files the build reads", () => {
  const digest = (entries) =>
    imageDigest("runtime-egress", tree(entries), readBlob);
  const original = digest({});
  assert.match(original, /^[0-9a-f]{32}$/u);
  assert.equal(digest({ "README.md": "readme-2" }), original);
  assert.equal(digest({ "services/ab/main.go": "other-2" }), original);
  assert.equal(digest({ "web/src/index.ts": "source-2" }), original);
  for (const changed of [
    { "services/a/main.go": "main-2" },
    { "services/a/new.go": "new-1" },
    { "web/package.json": "package-2" },
    { ".dockerignore": "ignore-2" },
    { "services/runtime-egress/Dockerfile": "dockerfile-3" },
  ])
    assert.notEqual(digest(changed), original, JSON.stringify(changed));
  assert.throws(
    () => digest({ "services/runtime-egress/Dockerfile": "dockerfile-2" }),
    /copies missing, which is not tracked/u,
  );
  assert.throws(
    () => imageDigest("runtime-egress", new Map(), readBlob),
    /services\/runtime-egress\/Dockerfile is not tracked/u,
  );
});

test("variant digests cover their base image inputs and their own build options", () => {
  const files = (entries = {}) =>
    tree({
      "runtimes/antnest-runtime/Dockerfile": "runtime-dockerfile",
      "runtimes/antnest-runtime/src/main.rs": "main-1",
      "tests/integration/antnest-runtime/a.rs": "probe-1",
      "tests/integration/skill-registry/package-rules-v1.json": "rules-1",
      "contracts/runtime/a.json": "contract-1",
      "contracts/platform/service-token-fixtures.json": "tokens-1",
      "tests/e2e/managed-mcp/Dockerfile": "managed-dockerfile",
      ...entries,
    });
  const blobs = {
    "runtime-dockerfile": [
      "FROM rust AS build",
      "COPY runtimes/antnest-runtime ./runtimes/antnest-runtime",
      "COPY tests/integration/antnest-runtime ./tests/integration/antnest-runtime",
      "COPY tests/integration/skill-registry/package-rules-v1.json ./x.json",
      "COPY contracts/runtime ./contracts/runtime",
      "COPY contracts/platform/service-token-fixtures.json ./y.json",
    ].join("\n"),
    "managed-dockerfile": "FROM ${RUNTIME_IMAGE}\nCOPY --from=fixture /a /b\n",
  };
  const read = (object) => blobs[object] ?? "";
  const digest = (name, entries) => imageDigest(name, files(entries), read);
  const managed = digest("antnest-runtime-managed");
  assert.notEqual(
    digest("antnest-runtime-managed", {
      "runtimes/antnest-runtime/src/main.rs": "main-2",
    }),
    managed,
  );
  assert.notEqual(
    digest("antnest-runtime-skill-gate"),
    digest("antnest-runtime"),
  );
});

test("every image digest resolves against the repository tree", () => {
  const head = listTree("HEAD");
  for (const name of Object.keys(images)) {
    const digest = imageDigest(name, head, (object) =>
      execFileSync("git", ["cat-file", "blob", object], { encoding: "utf8" }),
    );
    assert.match(digest, /^[0-9a-f]{32}$/u, name);
  }
});

test("image references name the GHCR package of each image", () => {
  assert.equal(
    imageReference("antnest-runtime", "abc"),
    "ghcr.io/tf4fun/antnest-runtime:inputs-abc",
  );
  assert.equal(
    imageReference("temporal", "abc"),
    "ghcr.io/tf4fun/antnest-temporal:inputs-abc",
  );
});

test("missing image references are built and existing ones are pulled", () => {
  const head = tree({});
  const checked = [];
  const resolved = resolveImages(["runtime-egress"], {
    tree: head,
    readBlob,
    exists: (ref) => {
      checked.push(ref);
      return false;
    },
  });
  const ref = imageReference(
    "runtime-egress",
    imageDigest("runtime-egress", head, readBlob),
  );
  assert.deepEqual(checked, [ref]);
  assert.deepEqual(resolved, [
    {
      name: "runtime-egress",
      dockerfile: "services/runtime-egress/Dockerfile",
      ref,
      build: true,
    },
  ]);
  assert.equal(
    resolveImages(["runtime-egress"], {
      tree: head,
      readBlob,
      exists: () => true,
    })[0].build,
    false,
  );
});

test("an unreachable or missing manifest counts as absent", () => {
  let call;
  assert.equal(
    imageExists("ghcr.io/x/y:z", (...args) => {
      call = args;
    }),
    true,
  );
  assert.deepEqual(call.slice(0, 2), [
    "docker",
    ["manifest", "inspect", "ghcr.io/x/y:z"],
  ]);
  assert.equal(
    imageExists("ghcr.io/x/y:z", () => {
      throw new Error("manifest unknown");
    }),
    false,
  );
});

test("suite images are the sorted union of the selected suites' images", () => {
  assert.deepEqual(
    suiteImages([
      { images: ["temporal", "antnest-runtime"] },
      { images: ["antnest-runtime"] },
      {},
    ]),
    ["antnest-runtime", "temporal"],
  );
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
