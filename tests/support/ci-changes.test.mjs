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
  listTree,
  matrices,
  matrix,
  matrixEntry,
  resolveImages,
  selectSuites,
  setups,
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
  for (const dockerfile of Object.values(images))
    assert(existsSync(resolve(root, dockerfile)), dockerfile);
});

test("matrix entries carry the tier and scalar setup flags", () => {
  const { include } = matrix(suites);
  assert.equal(include.length, suites.length);
  assert.deepEqual(
    new Set(include.map((row) => row.tier)),
    new Set(["A", "B", "C"]),
  );
  const entry = matrixEntry(
    suites.find((suite) => suite.id === "auth-runtime-controller"),
  );
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
  for (const row of include)
    for (const value of Object.values(row))
      assert(["string", "boolean"].includes(typeof value));
  assert.deepEqual(matrix([]), { include: [] });
});

test("required suites split by image need; tier C forms its own matrix", () => {
  const { plain, imaged, optional } = matrices(suites);
  assert.equal(
    plain.include.length + imaged.include.length + optional.include.length,
    suites.length,
  );
  assert(plain.include.every((row) => row.images === "" && row.tier !== "C"));
  assert(imaged.include.every((row) => row.images !== "" && row.tier !== "C"));
  assert(optional.include.every((row) => row.tier === "C"));
  assert(plain.include.some((row) => row.id === "egress-postgres"));
  assert(imaged.include.some((row) => row.id === "auth-runtime-controller"));
  assert(optional.include.some((row) => row.id === "c-stage3-local"));
  assert.deepEqual(matrices([]), {
    plain: { include: [] },
    imaged: { include: [] },
    optional: { include: [] },
  });
});

test("tier C platform scenarios get every local image and no rebuilding target", () => {
  const tierC = suites.filter((suite) => suite.tier === "c");
  assert(tierC.length >= 70);
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  for (const suite of tierC) {
    if (suite.images.length > 0)
      assert.deepEqual(suite.images, Object.keys(images).sort(), suite.id);
    const make = /^make ([\w.-]+)$/u.exec(suite.run[0]);
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
    assert.doesNotMatch(recipe.groups.body, /docker (?:compose .*)?build/u);
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
