import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  isPublishable,
  listTree,
  makefileChange,
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
  workflowPlan,
} from "./ci-changes.mjs";

test("the workflow plan preserves every shard and build exactly once", () => {
  const resolved = Object.keys(images).map((name) => ({
    name,
    ref: `test/${name}`,
    build: true,
    publish: false,
  }));
  const plan = workflowPlan(suites, resolved);
  const planned = [plan.plain, plan.imaged].flatMap((group) =>
    group.include.map((row) => row.id),
  );
  assert.deepEqual(
    planned.sort(),
    matrix(suites)
      .include.map((row) => row.id)
      .sort(),
  );
  assert.equal(new Set(planned).size, planned.length);
  assert.equal(plan.builds.include.length, resolved.length);
  const cached = workflowPlan(
    suites,
    resolved.map((row) => ({ ...row, build: false })),
  );
  assert.deepEqual(cached.builds.include, []);
});

test("every suite has exactly one kind and readiness has a nightly stress variant", () => {
  for (const suite of suites)
    assert(["component", "system", "stress"].includes(suite.kind), suite.id);
  const smoke = suites.find((suite) => suite.id === "c-agent-readiness");
  const stress = suites.find((suite) => suite.id === "stress-agent-readiness");
  assert.equal(smoke.kind, "system");
  assert.equal(stress.kind, "stress");
  assert.match(smoke.run[0], /ANTNEST_E2E_READINESS_ROUNDS=3 /u);
  assert.match(stress.run[0], /ANTNEST_E2E_READINESS_ROUNDS=100 /u);
  assert.deepEqual(
    selectSuites([], { all: true, scope: "stress" }).map((suite) => suite.id),
    ["stress-agent-readiness"],
  );
  assert(
    !selectSuites([], { all: true, scope: "system" }).includes(stress),
    "main system runs never include stress",
  );
});

import { temporaryStorageRoot } from "./storage.mjs";

test("ACP survivor admission runs the actual two-replica and browser scenario", () => {
  const suite = suites.find((item) => item.id === "c-acp-survivor");
  const owner = suites.find((item) => item.id === "acp-owner-bootstrap");
  assert(suite, "missing blocking two-Docker ACP survivor acceptance");
  assert(owner);
  assert.equal(suite.kind, "system");
  assert(!suite.disabled);
  assert.deepEqual(suite.run, ["node tests/e2e/acp-survivor/run.mjs"]);
  assert.deepEqual(suite.setup, ["agent-ui-web", "chromium"]);
  assert.deepEqual(suite.images, owner.images);
  assert.equal(
    suite.strict,
    true,
    "auxiliary trace warnings must not fail business admission",
  );
  assert.equal(outsideCI["e2e-acp-survivor"], undefined);
});

test("ACP survivor admission follows its producer, consumer and fixture changes", () => {
  for (const file of [
    "contracts/agent-acp/owner-incarnation-history.schema.json",
    "services/runtime-controller/internal/rpc/acp_incarnation.go",
    "services/agent-acp-service/src/composition.ts",
    "services/agent-ui/web/src/BridgeApp.tsx",
    "tests/e2e/acp-survivor/compose.yaml",
    "tests/e2e/acp-survivor/profile.mjs",
    "tests/e2e/acp-survivor/business.mjs",
    "tests/e2e/acp-survivor/browser.mjs",
    "tests/e2e/acp-survivor/run.mjs",
  ])
    assert(
      selectSuites([file]).some((suite) => suite.id === "c-acp-survivor"),
      `${file} must select actual survivor acceptance`,
    );
});

test("ACP survivor admission has one independent required shard", () => {
  const matches = shards.filter((shard) =>
    shard.suites.includes("c-acp-survivor"),
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "c-acp-survivor");
  assert.deepEqual(matches[0].suites, ["c-acp-survivor"]);
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const ids = (selected) => selected.map((suite) => suite.id);
const enabled = suites.filter((suite) => !suite.disabled);
const runtimeControllerAnonymousVolumeCommand =
  "ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET=/var/run/docker.sock ANTNEST_RUNTIME_CONTROLLER_TEST_ANONYMOUS_VOLUME_IMAGE=postgres:17.11-bookworm node tests/integration/go/run.mjs runtime-controller --profile integration --package internal/platform/docker -- -race -timeout=3m -run ^TestRemoveContainerDeletesAnonymousVolumesAndPreservesNamedResources$";

test("Controller recovery changes require both real automatic and original manual ACP restart admission", () => {
  for (const path of [
    "services/agent-controller/cmd/agent-controller/runtime_barrier_recovery.go",
    "services/agent-acp-service/src/adapters/postgres/runtime-barrier.ts",
    "tests/e2e/acp-restart/automatic-recovery-capture.mjs",
  ]) {
    const selected = selectSuites([path]);
    for (const name of ["acp-restart", "acp-restart-auto"]) {
      const suite = selected.find(({ id }) => id === `c-${name}`);
      assert(suite && !suite.disabled, `${path} must select ${name}`);
      assert.deepEqual(suite.run, [`make e2e-${name}`]);
      assert(
        shards
          .find(({ id }) => id === "c-acp-recovery")
          .suites.includes(suite.id),
      );
    }
  }
});

test("manual and notify browser recovery are mandatory restart profiles with Chromium setup", () => {
  for (const path of [
    "services/agent-controller/cmd/agent-controller/runtime_barrier_recovery.go",
    "services/agent-ui/web/src/WorkspacePage.tsx",
    "tests/e2e/acp-restart/browser-recovery.mjs",
  ]) {
    const selected = selectSuites([path]);
    for (const mode of ["manual-ui", "notify-ui"]) {
      const id = `c-acp-restart-${mode}`;
      const suite = selected.find((item) => item.id === id);
      assert(suite && !suite.disabled, `${path} must select ${id}`);
      assert.deepEqual(suite.setup, ["agent-ui-web", "chromium"]);
      assert.deepEqual(suite.run, [`make e2e-acp-restart-${mode}`]);
      assert(
        shards.find((item) => item.id === "c-acp-recovery").suites.includes(id),
      );
    }
  }
});

test("observation ordering always admits the real Controller consumer", () => {
  for (const path of [
    "tests/integration/runtime-controller/observation-consumer.mjs",
    "tests/integration/go/agent-controller/observationfixture/client.go",
    "services/agent-controller/internal/runtimeclient/observation.go",
    "services/agent-controller/internal/ports/runtime_observation.go",
    "services/agent-controller/go.mod",
    "services/agent-controller/go.sum",
  ]) {
    const suite = selectSuites([path]).find(
      ({ id }) => id === "runtime-controller-postgres",
    );
    assert(suite, `${path} must select the actual observation consumer`);
    assert.deepEqual(suite.run, [
      "make test-runtime-controller-postgres",
      runtimeControllerAnonymousVolumeCommand,
    ]);
  }
  const recipe = readFileSync(resolve(root, "Makefile"), "utf8").match(
    /^test-runtime-controller-postgres:\n(?<body>(?:\t.*\n)+)/mu,
  );
  assert(recipe, "Runtime Controller database admission recipe is required");
  assert.match(
    recipe.groups.body,
    /tests\/integration\/runtime-controller\/observation-consumer\.mjs/u,
  );
});

test("Runtime Controller container cleanup selects PostgreSQL admission with its cached image", () => {
  for (const path of [
    "services/runtime-controller/internal/platform/docker/client.go",
    "tests/integration/go/runtime-controller/internal/platform/docker/container_cleanup_integration_test.go",
  ]) {
    const suite = selectSuites([path]).find(
      ({ id }) => id === "runtime-controller-postgres",
    );
    assert(suite, `${path} must select the actual container cleanup admission`);
    assert.deepEqual(suite.run, [
      "make test-runtime-controller-postgres",
      runtimeControllerAnonymousVolumeCommand,
    ]);
    assert.deepEqual(suite.pull, [
      "postgres:17.11-bookworm",
      "node:24.21.0-bookworm-slim",
    ]);
  }
});

test("ACP Runtime information provenance runs against the candidate production image", () => {
  const command =
    "ANTNEST_ACP_TEST_IMAGE=antnest/agent-acp-service:local node tests/e2e/agent-acp-service/runtime-information-docker.mjs";
  for (const path of [
    "services/agent-acp-service/src/telemetry/runtime-information-read.ts",
    "tests/integration/agent-acp-service/adapters/mcp/runtime-information-close.test.ts",
    "tests/e2e/agent-acp-service/runtime-information-probe.mjs",
    "tests/e2e/agent-acp-service/runtime-information-docker.mjs",
    "services/agent-acp-service/src/telemetry/runtime-tool-lifecycle.ts",
    "tests/integration/agent-acp-service/adapters/mcp/tool-lifecycle.test.ts",
    "tests/e2e/agent-acp-service/runtime-tools-probe.mjs",
    "tests/e2e/lifecycle-closeout/docker.mjs",
    "tests/e2e/acp-closeout/docker.mjs",
    "tests/e2e/acp-closeout/network.mjs",
  ]) {
    const suite = selectSuites([path]).find(({ id }) => id === "auth-acp");
    assert(suite, `${path} must select ACP production admission`);
    assert.equal(suite.kind, "system");
    assert.deepEqual(suite.images, ["agent-acp-service"]);
    assert(suite.run.includes("make e2e-acp-authentication"));
    assert(suite.run.includes(command));
    assert(shards.some((shard) => shard.suites.includes(suite.id)));
  }
});

test("reference TLS proxy changes select the HTTPS browser and deployment contracts", () => {
  const selected = selectSuites(["deploy/tls/Caddyfile"]);
  assert(ids(selected).includes("gateway-tls"));
  assert(ids(selected).includes("deployment-contracts"));
  const tls = selected.find(({ id }) => id === "gateway-tls");
  assert(tls.pull.includes("caddy:2.11.7-alpine"));
  assert(tls.run.includes("make e2e-gateway-tls"));
});

test("browser session HTTPS integration is selected with each owning service and TLS deployment", () => {
  for (const file of [
    "services/identity-service/internal/repository/browser_sessions.go",
    "services/edge-gateway/internal/server/session.go",
    "services/admin-console/web/src/api.ts",
    "services/agent-ui/web/src/main.tsx",
    "tests/e2e/edge-gateway/browser-sessions-flow.mjs",
    "deploy/tls/Caddyfile",
  ]) {
    const selected = selectSuites([file]);
    const session = selected.find(({ id }) => id === "browser-sessions-https");
    assert(session, `${file} must select real browser session integration`);
    assert(session.pull.includes("caddy:2.11.7-alpine"));
    assert(session.setup.includes("chromium"));
    assert(session.run.includes("make e2e-browser-sessions-https"));
    assert(shards.some((shard) => shard.suites.includes(session.id)));
  }
});

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

test("workflow, selector, ownership, contract root and unattributed Makefile changes select every suite", () => {
  for (const file of [
    ".github/workflows/integration.yml",
    ".github/workflows/_suite.yml",
    "tests/support/ci-ownership.json",
    "tests/support/ci-changes.mjs",
    "tests/support/ci-impact.mjs",
    ".nvmrc",
    ".dockerignore",
    "Makefile",
    "contracts/README.md",
    "contracts/resource-identifiers.md",
  ])
    assert.equal(selectSuites([file]).length, enabled.length, file);
});

test("a system workflow change selects no pull request component suite", () => {
  assert.deepEqual(
    selectSuites([".github/workflows/e2e.yml"], { scope: "component" }),
    [],
  );
});

test("a contract change selects its declared owners, never every suite", () => {
  const selected = ids(selectSuites(["contracts/agent-ui/callers.json"]));
  for (const id of ["agent-ui-browser", "deployment-contracts", "gateway-tls"])
    assert(selected.includes(id), id);
  for (const id of ["identity-postgres", "agent-acp-postgres"])
    assert(!selected.includes(id), id);
  assert.notEqual(selected.length, enabled.length);
  assert.throws(
    () => selectSuites(["contracts/unknown-area/schema.json"]),
    /unknown contract/iu,
  );
});

test("a shared helper change selects the suites that transitively source it", () => {
  const sources = {
    list: () => ["tests/integration/go/identity-service/internal/x_test.go"],
    read: () => 'import "tests/support/helper.mjs";',
  };
  assert.deepEqual(
    ids(selectSuites(["tests/support/helper.mjs"], { sources })),
    ["identity-postgres", "deployment-contracts"],
    "only suites whose sources reach the helper run",
  );
  const dead = { list: () => [], read: () => "" };
  assert.equal(
    selectSuites(["tests/support/orphan.mjs"], { sources: dead }).length,
    enabled.length,
    "an unreferenced production helper conservatively selects all",
  );
  assert.deepEqual(
    selectSuites(["tests/support/orphan.test.mjs"], { sources: dead }),
    [],
    "an unreferenced test helper selects no suite",
  );
});

test("a shared test helper change alone selects no Docker suite", () => {
  const selected = ids(selectSuites(["tests/support/ci-shard.test.mjs"]));
  assert(!selected.includes("egress-postgres"));
  for (const suite of selected)
    assert(
      !(suite.pull ?? []).length && !(suite.images ?? []).length,
      `${suite.id} runs Docker on a test-only change`,
    );
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
    ids(
      selected.filter(
        (suite) => suite.kind !== "stress" && !suite.id.startsWith("c-"),
      ),
    );
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

test("dependency secret Docker admission is required by the system deployment suite", () => {
  const runner =
    "tests/e2e/service-authentication/deployment-credentials/dependency-secrets.mjs";
  const selected = selectSuites([runner]);
  const suite = selected.find(({ id }) => id === "deployment-docker");
  assert(suite);
  assert.equal(suite.kind, "system");
  assert(suite.run.includes(`node ${runner}`));
  assert(suite.images.includes("temporal"));
  assert(suite.pull.includes("temporalio/server:1.32.0"));
  const shard = shards.find(({ id }) => id === "b-deployment");
  assert(shard.suites.includes(suite.id));
});

test("documented Docker admissions include encryption rotation, Gateway shutdown and RC archives", async (t) => {
  const cases = [
    {
      id: "c-encryption-key-rotation",
      kind: "system",
      path: "tests/e2e/skill-learning/automatic-flow.test.mjs",
      command: "make e2e-encryption-key-rotation",
      images: [
        "agent-acp-service",
        "agent-controller",
        "admin-console",
        "identity-service",
      ],
    },
    {
      id: "gateway-shutdown",
      kind: "system",
      path: "tests/e2e/edge-gateway/shutdown-docker.mjs",
      command:
        "ANTNEST_GATEWAY_TEST_IMAGE=antnest/edge-gateway:local node tests/e2e/edge-gateway/shutdown-docker.mjs",
      images: ["edge-gateway"],
    },
    {
      id: "runtime-controller-skill-archives",
      kind: "system",
      path: "tests/e2e/go/runtime-controller/internal/platform/docker/skill_archive_e2e_test.go",
      command:
        "ANTNEST_TEST_DOCKER_SOCKET=/var/run/docker.sock node tests/integration/go/run.mjs runtime-controller --profile e2e --package internal/platform/docker -- -race -timeout=5m",
      images: ["antnest-runtime"],
    },
  ];
  for (const entry of cases)
    await t.test(entry.id, () => {
      const suite = selectSuites([entry.path]).find(
        ({ id }) => id === entry.id,
      );
      assert(suite, `${entry.id} must run when its test changes`);
      assert.equal(suite.kind, entry.kind);
      assert(suite.run.includes(entry.command), entry.command);
      for (const image of entry.images)
        assert(suite.images.includes(image), image);
      assert.equal(
        shards.filter((shard) => shard.suites.includes(entry.id)).length,
        1,
      );
    });
});

test("Gateway shutdown interruption changes select the owning Docker admission", () => {
  for (const path of [
    "tests/e2e/edge-gateway/shutdown-interruption.mjs",
    "tests/e2e/edge-gateway/shutdown-interruption.test.mjs",
  ])
    assert(
      ids(selectSuites([path])).includes("gateway-shutdown"),
      `${path} must select Gateway shutdown`,
    );
});

test("Gateway shutdown declares its actual trace collector image", () => {
  const suite = suites.find(({ id }) => id === "gateway-shutdown");
  assert(
    suite.pull.includes("cr.jaegertracing.io/jaegertracing/jaeger:2.21.0"),
  );
});

test("repository admission runs the Gateway shutdown interruption tests", () => {
  const commands = execFileSync("make", ["--dry-run", "test-repo"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  }).split("\n");
  assert(
    commands.some(
      (command) =>
        /^node --test\s/u.test(command) &&
        command
          .split(/\s+/u)
          .includes("tests/e2e/edge-gateway/shutdown-interruption.test.mjs"),
    ),
    "make test-repo must execute shutdown interruption tests",
  );
});

test("an explicit full run selects every enabled suite without any changes", () => {
  assert.deepEqual(selectSuites([], { all: true }), enabled);
});

test("the scope option intersects every selection mode afterwards", () => {
  const components = selectSuites([], { all: true, scope: "component" });
  assert.deepEqual(
    components,
    enabled.filter((suite) => suite.kind === "component"),
  );
  for (const scope of ["system", "stress"])
    assert.deepEqual(
      selectSuites([], { all: true, scope }),
      enabled.filter((suite) => suite.kind === scope),
    );
  assert.deepEqual(
    ids(
      selectSuites(["services/identity-service/internal/server/http.go"], {
        scope: "component",
      }),
    ),
    ["identity-postgres", "deployment-contracts"],
  );
  assert.deepEqual(
    ids(
      selectSuites([], {
        only: ["auth-acp", "egress-postgres"],
        scope: "component",
      }),
    ),
    ["egress-postgres"],
    "a scoped manual selection cannot enable E2E suites",
  );
  assert.throws(
    () => selectSuites([], { all: true, scope: "sideways" }),
    /unknown scope sideways/iu,
  );
});

test("a Makefile change selects the suites whose make targets reach it", () => {
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  const select = (targets, files = ["Makefile"]) =>
    ids(selectSuites(files, { makefile: { targets, texts: [makefile] } }));
  assert.deepEqual(select(new Set(["test-egress-postgres"])), [
    "egress-postgres",
  ]);
  assert.deepEqual(
    select(new Set(["e2e-service-authentication-integration"])),
    ["c-service-authentication-integration", "c-encryption-key-rotation"],
    "a recursive $(MAKE) call reaches the target",
  );
  assert.deepEqual(select(new Set(["fmt"])), [], "no suite runs fmt");
  assert.deepEqual(select(new Set()), [], "a comment-only change runs none");
  const fixture = [
    "test-egress-postgres: helper-z",
    "\tsh x",
    "helper-z:",
    "\ttrue",
    "",
  ].join("\n");
  assert.deepEqual(
    ids(
      selectSuites(["Makefile"], {
        makefile: { targets: new Set(["helper-z"]), texts: [fixture] },
      }),
    ),
    ["egress-postgres"],
    "a prerequisite change reaches the suite",
  );
  assert(
    select(new Set(["test-egress-postgres"]), [
      "Makefile",
      "services/identity-service/internal/server/http.go",
    ]).includes("identity-postgres"),
    "other changed files still select their suites",
  );
});

test("an unattributed Makefile change stays conservative", () => {
  for (const makefile of [undefined, { targets: null, texts: [] }])
    assert.equal(
      selectSuites(["Makefile"], { makefile }).length,
      enabled.length,
    );
});

test("makefileChange reports changed targets and both Makefile revisions", () => {
  const base = "test-a:\n\tnode a.mjs\n";
  const head = "test-a:\n\tnode a2.mjs\n";
  const git = (command, args) => {
    if (args[0] === "diff") return "@@ -2 +2 @@\n";
    if (args[0] === "show") return args[1] === "base:Makefile" ? base : head;
    throw new Error(`unexpected ${args}`);
  };
  assert.deepEqual(makefileChange("base", "head", git), {
    targets: new Set(["test-a"]),
    texts: [base, head],
  });
  assert.deepEqual(
    makefileChange("base", "head", () => {
      throw new Error("no history");
    }),
    { targets: null, texts: [] },
  );
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
    assert(["component", "system", "stress"].includes(suite.kind), suite.id);
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

test("every suite belongs to exactly one shard of its own kind", () => {
  const members = shards.flatMap((shard) => shard.suites);
  assert.equal(new Set(members).size, members.length);
  assert.deepEqual([...members].sort(), ids(suites).sort());
  assert.equal(new Set(shards.map((shard) => shard.id)).size, shards.length);
  for (const shard of shards) {
    assert(shard.suites.length > 0, shard.id);
    const kinds = new Set(
      shard.suites.map((id) => suites.find((suite) => suite.id === id).kind),
    );
    assert.equal(kinds.size, 1, shard.id);
  }
  assert(shards.filter((shard) => shard.id.startsWith("c-")).length <= 13);
});

test("every component PostgreSQL, browser and contract suite has its own shard", () => {
  const singletons = [
    ["a-egress-postgres", "egress-postgres"],
    ["a-runtime-controller-postgres", "runtime-controller-postgres"],
    ["a-identity-postgres", "identity-postgres"],
    ["a-agent-controller-postgres", "agent-controller-postgres"],
    ["a-agent-acp-postgres", "agent-acp-postgres"],
    ["a-admin-console-browser", "admin-console-browser"],
    ["a-agent-ui-browser", "agent-ui-browser"],
    ["a-deployment-contracts", "deployment-contracts"],
    ["a-elicitation-sdk-probe", "elicitation-sdk-probe"],
  ];
  for (const [shardId, suiteId] of singletons) {
    const shard = shards.find((item) => item.id === shardId);
    const suite = suites.find((item) => item.id === suiteId);
    assert(shard, `missing one-suite component shard ${shardId}`);
    assert.deepEqual(shard.suites, [suiteId]);
    assert.equal(shard.name, suite.name);
    assert.equal(suite.kind, "component");
  }
  assert.deepEqual(
    shards.filter((shard) => shard.id.startsWith("a-")).map(({ id }) => id),
    singletons.map(([id]) => id),
  );
});

test("selecting one PostgreSQL suite never schedules the others", () => {
  const postgres = [
    "egress-postgres",
    "runtime-controller-postgres",
    "identity-postgres",
    "agent-controller-postgres",
    "agent-acp-postgres",
  ];
  const all = matrix(
    suites.filter((suite) => postgres.includes(suite.id)),
  ).include;
  assert.deepEqual(
    all.map((row) => row.id),
    postgres.map((id) => `a-${id}`),
  );
  for (const row of all) assert.equal(JSON.parse(row.suites).length, 1);
  const only = matrix(
    suites.filter((suite) => suite.id === "identity-postgres"),
  ).include;
  assert.deepEqual(
    only.map((row) => row.id),
    ["a-identity-postgres"],
  );
});

test("suite entries carry the kind and scalar setup flags", () => {
  const entry = matrixEntry(
    suites.find((suite) => suite.id === "auth-runtime-controller"),
  );
  assert.equal(entry.kind, "system");
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
    new Set(include.map((row) => row.kind)),
    new Set(["component", "system", "stress"]),
  );
  for (const row of include)
    for (const value of Object.values(row))
      assert(["string", "boolean"].includes(typeof value));
  const pick = (...names) => suites.filter((suite) => names.includes(suite.id));
  const postgres = matrix(
    pick("agent-controller-postgres", "egress-postgres", "auth-console"),
  ).include;
  assert.deepEqual(
    postgres.map((row) => row.id),
    ["a-egress-postgres", "a-agent-controller-postgres", "b-auth"],
  );
  assert.deepEqual(
    JSON.parse(postgres[0].suites).map(({ id }) => id),
    ["egress-postgres"],
  );
  assert.equal(postgres[0].images, "");
  assert.equal(postgres[0].setup_go, false);
  assert.equal(postgres[0].setup_rust, true);
  assert.equal(postgres[0].setup_chromium, false);
  assert.deepEqual(
    JSON.parse(postgres[1].suites).map(({ id }) => id),
    ["agent-controller-postgres"],
  );
  assert.equal(postgres[1].images, "temporal");
  assert.equal(postgres[1].setup_go, true);
  assert.equal(postgres[1].setup_rust, false);
  const [deployment] = matrix(
    pick("deployment-transports", "deployment-docker"),
  ).include;
  assert.equal(deployment.id, "b-deployment");
  assert.deepEqual(
    JSON.parse(deployment.suites).map(({ id }) => id),
    ["deployment-docker", "deployment-transports"],
  );
  assert.equal(deployment.images, "temporal");
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

test("PostgreSQL components use one isolated shard per owning service", () => {
  const ids = [
    "egress-postgres",
    "runtime-controller-postgres",
    "identity-postgres",
    "agent-controller-postgres",
    "agent-acp-postgres",
  ];
  const owners = ids.map((id) =>
    shards.filter((shard) => shard.suites.includes(id)),
  );
  assert(owners.every((matches) => matches.length === 1));
  assert.equal(new Set(owners.map(([shard]) => shard.id)).size, 5);
  for (const [shard] of owners) assert.equal(shard.suites.length, 1);
});

test("stage2 selection is independent of the component ACP PostgreSQL suite", () => {
  for (const selected of [
    selectSuites([], { only: ["c-stage2"] }),
    selectSuites(["tests/e2e/e2e-stage2.sh"]),
  ]) {
    assert(selected.some((suite) => suite.id === "c-stage2"));
    assert(!selected.some((suite) => suite.id === "agent-acp-postgres"));
  }
});

test("stage2 keeps boundary flow and worker recovery without the ACP run", () => {
  const source = readFileSync(
    new URL("../e2e/e2e-stage2.sh", import.meta.url),
    "utf8",
  );
  assert.match(source, /stage2-boundary-flow/u);
  assert.match(source, /TestTemporal/u);
  assert.doesNotMatch(source, /stage2_acp_test|test:postgres/u);
});

test("shards split by image need", () => {
  const { plain, imaged } = matrices(suites);
  assert.equal(plain.include.length + imaged.include.length, shards.length);
  assert(plain.include.every((row) => row.images === ""));
  assert(imaged.include.every((row) => row.images !== ""));
  assert(plain.include.some((row) => row.id === "a-admin-console-browser"));
  assert(imaged.include.some((row) => row.id === "b-auth"));
  assert(imaged.include.some((row) => row.id === "c-acp"));
  assert.deepEqual(matrices([]), {
    plain: { include: [] },
    imaged: { include: [] },
  });
});

test("the network and signed-context matrix is a required production-stack suite", () => {
  const suite = suites.find((item) => item.id === "auth-network-matrix");
  assert(suite, "missing blocking authentication matrix");
  assert.equal(suite.kind, "system");
  assert.deepEqual(suite.setup, []);
  assert.deepEqual(suite.run, ["make e2e-service-authentication-matrix"]);
  assert.deepEqual(
    [...suite.images].sort(),
    Object.keys(images)
      .filter((name) => typeof images[name] === "string")
      .sort(),
  );
  assert.deepEqual(suite.pull, [
    "postgres:17.11-bookworm",
    "node:24.21.0-bookworm-slim",
    "temporalio/admin-tools:1.32.0",
    "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0",
  ]);
  for (const file of [
    ...suite.images.map((name) =>
      name === "antnest-runtime"
        ? "runtimes/antnest-runtime/src/main.rs"
        : name === "temporal"
          ? "scripts/temporal/Dockerfile"
          : `services/${name}/Dockerfile`,
    ),
    "modules/service-authentication/token/authentication.go",
    "tests/e2e/security/network-flow.mjs",
    "tests/e2e/security/authenticated-flow.mjs",
    "tests/e2e/acp-closeout/docker.mjs",
    "tests/e2e/acp-closeout/network.mjs",
    "tests/e2e/workspace-closeout/c4-setup.mjs",
    "tests/e2e/skill-learning/deployment.compose.yaml",
    "tests/e2e/identity-closeout/support.mjs",
    "tests/e2e/identity-closeout/evidence.mjs",
    "tests/e2e/observability/collect.mjs",
    "tests/e2e/observability/trace-tree.mjs",
    "compose.yaml",
  ])
    assert(ids(selectSuites([file])).includes(suite.id), file);
  const { plain, imaged } = matrices([suite]);
  assert.deepEqual(plain.include, []);
  assert.equal(imaged.include.length, 1);
  assert.equal(imaged.include[0].id, "b-auth-matrix");
  assert.equal(imaged.include[0].kind, "system");
  assert.deepEqual(
    JSON.parse(imaged.include[0].suites).map(({ id }) => id),
    [suite.id],
  );
  const integration = suites.find(
    (item) => item.id === "c-service-authentication-integration",
  );
  assert.equal(integration.kind, "system");
  assert.deepEqual(integration.run, [
    "make e2e-service-authentication-integration",
  ]);
});

test("ACP owner bootstrap is a separate required suite with the production matrix images", () => {
  const baseline = suites.find((item) => item.id === "auth-network-matrix");
  const suite = suites.find((item) => item.id === "acp-owner-bootstrap");
  assert(baseline, "the default authentication matrix must remain available");
  assert(suite, "missing blocking ACP owner bootstrap suite");
  assert(!baseline.disabled);
  assert(!suite.disabled);
  assert.equal(suite.kind, "system");
  assert.deepEqual(suite.setup, baseline.setup);
  assert.deepEqual(suite.run, ["node tests/e2e/security/owner-run.mjs"]);
  assert.deepEqual(baseline.run, ["make e2e-service-authentication-matrix"]);
  assert.deepEqual(suite.images, baseline.images);
  assert.deepEqual(suite.pull, baseline.pull);
});

test("ACP owner bootstrap changes select both optional-profile and default authentication admission", () => {
  for (const file of [
    "services/agent-acp-service/src/composition.ts",
    "services/agent-acp-service/src/config.ts",
    "services/runtime-controller/internal/acpincarnation/service.go",
    "services/runtime-controller/internal/platform/docker/acp_incarnation.go",
    "tests/e2e/security/owner-run.mjs",
    "tests/e2e/security/owner-profile.mjs",
    "tests/e2e/security/owner-registration.mjs",
    "tests/e2e/security/network-matrix.mjs",
    "tests/e2e/security/run.mjs",
    "tests/e2e/security/owner.compose.yaml",
    "compose.yaml",
    "compose.debug.yaml",
    "compose.stage3.yaml",
    "compose.native-tls.yaml",
    "compose.tls.yaml",
    ".env.example",
    "scripts/dev-service-tokens.mjs",
    "tests/e2e/lifecycle-closeout/compose.yaml",
  ]) {
    const selected = ids(selectSuites([file]));
    for (const id of ["auth-network-matrix", "acp-owner-bootstrap"])
      assert(selected.includes(id), `${file} must select ${id}`);
  }
});

test("ACP owner bootstrap shares the required auth matrix shard without replacing the default suite", () => {
  const baseline = suites.find((item) => item.id === "auth-network-matrix");
  const suite = suites.find((item) => item.id === "acp-owner-bootstrap");
  const shard = shards.find((item) => item.id === "b-auth-matrix");
  assert(baseline, "the default authentication matrix must remain available");
  assert(suite, "missing blocking ACP owner bootstrap suite");
  assert(shard, "missing required authentication matrix shard");
  for (const id of [baseline.id, suite.id]) {
    assert(shard.suites.includes(id), `${id} must run in b-auth-matrix`);
    assert.equal(
      shards.filter((item) => item.suites.includes(id)).length,
      1,
      `${id} must belong to exactly one shard`,
    );
  }
  for (const selected of [[suite], [baseline, suite]]) {
    const { plain, imaged } = matrices(selected);
    assert.deepEqual(plain.include, []);
    assert.equal(imaged.include.length, 1);
    const [entry] = imaged.include;
    assert.equal(entry.id, "b-auth-matrix");
    assert.equal(entry.kind, "system");
    assert.equal(entry.images, [...baseline.images].sort().join(","));
    assert.deepEqual(
      JSON.parse(entry.suites)
        .map(({ id }) => id)
        .sort(),
      ids(selected).sort(),
    );
  }
});

test("ACP authentication runs in the required auth shard with its CI-built image", () => {
  const suite = suites.find((item) => item.id === "auth-acp");
  assert(suite, "missing ACP authentication suite");
  assert.equal(suite.kind, "system");
  assert.deepEqual(suite.setup, []);
  assert.deepEqual(suite.images, ["agent-acp-service"]);
  assert.deepEqual(suite.pull, [
    "postgres:17.11-bookworm",
    "node:24.21.0-bookworm-slim",
  ]);
  assert.deepEqual(suite.run, [
    "make e2e-acp-authentication",
    "ANTNEST_ACP_TEST_IMAGE=antnest/agent-acp-service:local node tests/e2e/agent-acp-service/runtime-information-docker.mjs",
  ]);
  for (const file of [
    "services/agent-acp-service/src/server.ts",
    "services/agent-acp-service/test/fixtures/execution-configuration.ts",
    "tests/e2e/agent-acp-service/sdk-regressions-docker.mjs",
    "tests/e2e/service-authentication/acp/auth-fixture.mjs",
    "tests/e2e/service-authentication/acp/provider-policy-docker.mjs",
    "compose.yaml",
  ])
    assert(ids(selectSuites([file])).includes(suite.id), file);
  const { plain, imaged } = matrices([suite]);
  assert.deepEqual(plain.include, []);
  assert.equal(imaged.include.length, 1);
  assert.equal(imaged.include[0].id, "b-auth");
  assert.equal(imaged.include[0].kind, "system");
  assert.equal(imaged.include[0].images, "agent-acp-service");
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  assert.match(
    makefile,
    /^e2e-acp-authentication:\n\tANTNEST_ACP_AUDIT_IMAGE="\$\$\{ANTNEST_ACP_AUDIT_IMAGE:-antnest\/agent-acp-service:local\}" node --import \.\/services\/agent-acp-service\/node_modules\/tsx\/dist\/loader\.mjs tests\/e2e\/agent-acp-service\/sdk-regressions-docker\.mjs$/mu,
  );
});

test("platform scenarios get every local image and no rebuilding target", () => {
  const platform = suites.filter((suite) => /^(?:c|stress)-/u.test(suite.id));
  assert.equal(platform.length, 54);
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  const primary = Object.keys(images).filter(
    (name) => typeof images[name] === "string",
  );
  const variants = {
    "c-tool-permissions": ["antnest-runtime-fixture"],
    "c-tool-progress": ["antnest-runtime-fixture"],
    ...Object.fromEntries(
      platform
        .filter((suite) => suite.id.startsWith("c-skill-learning-install-"))
        .map((suite) => [suite.id, ["antnest-runtime-skill-gate"]]),
    ),
  };
  assert.equal(Object.keys(variants).length, 9);
  for (const suite of platform) {
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

test("Permissions CI supplies the fixture carrier while its deployment builds the current production-based final image", () => {
  const suite = suites.find((item) => item.id === "c-tool-permissions");
  assert(!suite.run.includes("make docker-build-managed-runtime"));
  assert(suite.images.includes("antnest-runtime-fixture"));
  assert(suite.images.includes("antnest-runtime"));
  assert(!suite.images.includes("antnest-runtime-managed"));
  const shell = readFileSync(
    resolve(root, "tests/e2e/e2e-tool-permissions.sh"),
    "utf8",
  );
  assert.match(shell, /acp-permissions\/deployment\.mjs" create-harness/u);
  assert.doesNotMatch(shell, /managed-integration|docker\.sock|--user 0:0/u);
});

test("Progress CI supplies the fixture carrier while its deployment builds the current production-based final image", () => {
  const suite = suites.find((item) => item.id === "c-tool-progress");
  assert(!suite.run.includes("make docker-build-managed-runtime"));
  assert(suite.images.includes("antnest-runtime-fixture"));
  assert(suite.images.includes("antnest-runtime"));
  assert(!suite.images.includes("antnest-runtime-managed"));
  const shell = readFileSync(
    resolve(root, "tests/e2e/e2e-tool-progress.sh"),
    "utf8",
  );
  assert.match(shell, /acp-progress\/deployment\.mjs" create-harness/u);
  assert.doesNotMatch(shell, /managed-integration|docker\.sock|--user 0:0/u);
});

test("Stage 3a profiles keep their strict exit 2 by running the make recipe directly", () => {
  const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
  for (const name of [
    "stage3-local",
    "stage3-skill-delivery",
    "stage4-skill-offline-reuse",
    "stage4-skill-registry-outage",
    "stage4-skill-restart-rebuild",
    "acp-closeout",
    "acp-session",
    "slash-commands",
    "structured-plan",
    "multimodal",
    "session-cost",
    "file-observations",
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
    assert.deepEqual(suite.run.slice(0, -1), [], name);
    assert.equal(suite.strict, true, name);
  }
});

test("organization display installs the Agent UI browser client", () => {
  const suite = suites.find((item) => item.id === "c-organization-display");
  assert.deepEqual(suite.setup, ["agent-ui-web", "chromium"]);
});

test("Session observer installs its Agent UI dependencies without Chromium", () => {
  const suite = suites.find((item) => item.id === "c-acp-session");
  assert.deepEqual(suite.setup, ["agent-ui-web"]);
  const entry = matrixEntry(suite);
  assert.equal(entry.setup_agent_ui_web, true);
  assert.equal(entry.setup_chromium, false);
});

test("foundation runners report strict-only findings through exit 2", () => {
  const foundation = {
    "c-acp-survivor": "acp-survivor/run.mjs",
    "gateway-resolve-cache": "edge-gateway/resolve-cache-docker.mjs",
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
      if (!/(?:^| )sh tests\/e2e\/e2e-stage3a\.sh$/u.test(entry.run))
        assert.equal(entry.strict_exit, false, suite.id);
      continue;
    }
    assert.equal(entry.strict_exit, true, suite.id);
    // make reports every failed recipe as 2, which would hide the runner's code.
    assert.equal(entry.run, `node tests/e2e/${foundation[suite.id]}`);
  }
});

test("lifecycle reliability is a business-only system suite, not a PR or stress gate", () => {
  const suite = suites.find((item) => item.id === "c-lifecycle-reliability");
  assert(suite);
  assert.equal(suite.kind, "system");
  assert.deepEqual(suite.run, [
    "node tests/e2e/lifecycle-closeout/run.mjs reliability",
  ]);
  assert.deepEqual(
    suite.images,
    suites.find((item) => item.id === "c-lifecycle-loss").images,
  );
  assert.equal(matrixEntry(suite).strict_exit, false);
  const files = ["services/agent-controller/internal/orchestration/create.go"];
  for (const scope of ["component", "system", "stress"]) {
    assert.equal(
      selectSuites(files, { scope }).some((item) => item.id === suite.id),
      scope === "system",
    );
  }
});

test("upload capacity runs the real two-user gate and its counterexamples in required CI", () => {
  const suite = suites.find((item) => item.id === "agent-ui-upload-capacity");
  assert(suite);
  assert.equal(suite.kind, "system");
  assert.deepEqual(suite.setup, ["agent-ui-web"]);
  assert.deepEqual(suite.run, ["make e2e-agent-ui-upload-capacity"]);
  assert(
    suite.pull.includes("cr.jaegertracing.io/jaegertracing/jaeger:2.21.0"),
  );
  assert.deepEqual(
    suite.images,
    suites.find((item) => item.id === "gateway-tls").images,
  );
  assert(
    shards.find((item) => item.id === "b-gateway").suites.includes(suite.id),
  );
  for (const path of [
    "services/agent-ui/web/server/src/http/json-request.ts",
    "tests/e2e/agent-ui/upload-capacity-docker.mjs",
  ]) {
    assert(selectSuites([path]).some((item) => item.id === suite.id));
  }
  const commands = execFileSync("make", ["--dry-run", "test-repo"], {
    encoding: "utf8",
  });
  assert.match(
    commands,
    /node --test --test-concurrency=1 tests\/e2e\/agent-ui\/upload-capacity-\*\.test\.mjs/u,
  );
  const run = execFileSync(
    "make",
    ["--no-print-directory", "--dry-run", "e2e-agent-ui-upload-capacity"],
    { encoding: "utf8" },
  );
  assert.equal(
    run.trim(),
    "node tests/e2e/agent-ui/upload-capacity-docker.mjs",
  );
});

test("resolve cache outage is a system observed HTTPS suite", () => {
  const suite = suites.find((item) => item.id === "gateway-resolve-cache");
  assert(suite);
  assert.equal(suite.kind, "system");
  assert.equal(suite.strict, true);
  assert.deepEqual(suite.setup, ["agent-ui-web"]);
  assert(suite.pull.includes("caddy:2.11.7-alpine"));
  assert(
    suite.pull.includes("cr.jaegertracing.io/jaegertracing/jaeger:2.21.0"),
  );
  assert.deepEqual(
    suite.images,
    suites.find((item) => item.id === "gateway-tls").images,
  );
  assert(
    shards.find((item) => item.id === "b-gateway").suites.includes(suite.id),
  );
  assert(
    selectSuites(["services/edge-gateway/internal/auth/cache.go"]).some(
      (item) => item.id === suite.id,
    ),
  );
  const makefile = readFileSync(
    new URL("../../Makefile", import.meta.url),
    "utf8",
  );
  assert.match(makefile, /\t\$\(MAKE\) test-resolve-cache-fixtures/u);
  assert.match(
    makefile,
    /test-resolve-cache-fixtures:\n\tnode --test --test-concurrency=1 tests\/e2e\/edge-gateway\/resolve-cache-\*\.test\.mjs/u,
  );
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

const localOnlyImages = [
  "temporal",
  "antnest-runtime-fixture",
  "antnest-runtime-managed",
  "antnest-runtime-skill-gate",
];

test("only service and Runtime release images receive GHCR references", () => {
  const components = [
    "antnest-runtime",
    ...readdirSync(resolve(root, "services")),
  ].sort();
  const published = Object.keys(images).filter((name) =>
    imageReference(name, "abc").startsWith("ghcr.io/"),
  );
  assert.deepEqual(published.sort(), components);
  assert.equal(
    imageReference("antnest-runtime", "abc"),
    "ghcr.io/tf4fun/antnest-runtime:inputs-abc",
  );
  assert.equal(
    imageReference("runtime-egress", "abc"),
    "ghcr.io/tf4fun/antnest-runtime-egress:inputs-abc",
  );
  for (const name of localOnlyImages)
    assert.equal(imageReference(name, "abc"), `antnest/${name}:local`);
  assert.throws(() => imageReference("unknown", "abc"), /unknown image/u);
});

test("no option makes a test image registry-eligible", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/support/ci-changes.mjs", "--all", "--registry-images"],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  assert.notEqual(result.status, 0, "the registry-images option is gone");
  for (const name of localOnlyImages)
    assert.equal(imageReference(name, "abc"), `antnest/${name}:local`);
});

test("dependency and fixture images always use the current run's artifact, even if an old package exists", () => {
  const head = listTree("HEAD");
  const checked = [];
  const resolved = resolveImages(localOnlyImages, {
    tree: head,
    readBlob: (object) =>
      execFileSync("git", ["cat-file", "blob", object], { encoding: "utf8" }),
    exists: (ref) => {
      checked.push(ref);
      return true;
    },
  });
  assert.deepEqual(checked, [], "local-only images must never query GHCR");
  for (const image of resolved) {
    assert.equal(image.ref, `antnest/${image.name}:local`);
    assert.equal(image.build, true, image.name);
    assert.equal(image.publish, false, image.name);
  }
});

test("Temporal retains a build cache without publishing a package", () => {
  const temporal = bakeDefinition(["temporal"]).target.temporal;
  assert.deepEqual(temporal.tags, ["antnest/temporal:local"]);
  assert.deepEqual(temporal["cache-to"], [
    "type=gha,mode=max,scope=antnest-temporal",
  ]);
});

test("the component image job builds artifacts and never publishes", () => {
  const workflow = readFileSync(
    resolve(root, ".github/workflows/integration.yml"),
    "utf8",
  );
  const imageJob = workflow.split("\n  images:\n")[1].split("\n  suite:\n")[0];
  assert.doesNotMatch(imageJob, /docker\/login-action/u);
  assert.doesNotMatch(imageJob, /docker push|Publish/u);
  assert.match(imageJob, /docker save/u);
  assert.match(imageJob, /upload-artifact/u);
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
      publish: true,
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

test("a main version set covers every release and test image", () => {
  const every = Object.keys(images).sort();
  assert.deepEqual(suiteImages([], { allImages: true }), every);
  assert.deepEqual(
    suiteImages([{ images: ["temporal", "antnest-runtime-managed"] }], {
      allImages: true,
    }),
    every,
  );
  assert.deepEqual(
    suiteImages([{ images: ["temporal", "antnest-runtime-managed"] }]),
    ["antnest-runtime-managed", "temporal"],
    "without --all-images only the selected suites' images resolve",
  );
});

test("CLI outputs retain publication eligibility and artifact routing across registry hits and misses", (t) => {
  const directory = mkdtempSync(
    resolve(temporaryStorageRoot(), "antnest-ci-image-plan-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    resolve(directory, "docker"),
    [
      "#!/bin/sh",
      '[ "$1" = manifest ] && [ "$2" = inspect ] || exit 9',
      'printf "%s\\n" "$3" >> "$CI_TEST_MANIFEST_LOG"',
      'exit "$CI_TEST_MANIFEST_STATUS"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  for (const [id, only, status, allImages] of [
    ["present", "auth-runtime,managed-mcp-secrets-v1", "0", false],
    ["missing", "auth-runtime,managed-mcp-secrets-v1", "1", true],
    ["no-dependencies", "deployment-contracts", "0", true],
  ]) {
    const output = resolve(directory, `${id}.output`);
    const manifests = resolve(directory, `${id}.manifests`);
    execFileSync(
      process.execPath,
      [
        "tests/support/ci-changes.mjs",
        "--all",
        "--resolve-images",
        "--only",
        only,
        ...(allImages ? ["--all-images"] : []),
      ],
      {
        cwd: root,
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CI_TEST_MANIFEST_LOG: manifests,
          CI_TEST_MANIFEST_STATUS: status,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: resolve(directory, `${id}.summary`),
        },
      },
    );
    const lines = Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    const resolved = JSON.parse(lines.images);
    const builds = JSON.parse(lines.builds).include;
    const releaseNames = Object.keys(images).filter(
      (name) => !localOnlyImages.includes(name),
    );
    const queried = readFileSync(manifests, "utf8").trim().split("\n");
    assert.equal(queried.length, releaseNames.length, id);
    for (const ref of queried) {
      assert.match(ref, /^ghcr\.io\/tf4fun\//u);
      assert(!localOnlyImages.some((name) => ref.includes(`${name}:`)), ref);
    }
    assert.equal(Number(lines.building), builds.length);
    // A main run builds every test image even when no selected suite needs
    // one, so its manifest can replay any suite; none is ever queried.
    if (id === "no-dependencies")
      assert.deepEqual(
        Object.keys(resolved).sort(),
        Object.keys(images).sort(),
      );
    assert.equal(builds.length, status === "0" ? 4 : 14, id);
    for (const name of localOnlyImages) {
      assert.deepEqual(resolved[name], {
        ref: `antnest/${name}:local`,
        build: true,
      });
      assert.deepEqual(
        builds.find((image) => image.name === name),
        {
          name,
          ref: `antnest/${name}:local`,
          publish: false,
        },
      );
    }
    for (const name of releaseNames) {
      assert.equal(resolved[name].build, status === "1", name);
      if (status === "1")
        assert.equal(
          builds.find((image) => image.name === name).publish,
          true,
          name,
        );
    }
  }
});

test("the CLI reports a combined system matrix alongside the scoped suites", (t) => {
  const directory = mkdtempSync(
    resolve(temporaryStorageRoot(), "antnest-ci-system-plan-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (args, name) => {
    const output = resolve(directory, `${name}.output`);
    const result = spawnSync(
      process.execPath,
      ["tests/support/ci-changes.mjs", ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, GITHUB_OUTPUT: output },
      },
    );
    return { result, output };
  };
  const e2e = run(["--scope", "system", "--all"], "system");
  assert.equal(e2e.result.status, 0, e2e.result.stderr);
  const lines = Object.fromEntries(
    readFileSync(e2e.output, "utf8")
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  const system = JSON.parse(lines.system_suites);
  assert.equal(Number(lines.system_count), system.include.length);
  assert(system.include.length > 0);
  for (const row of system.include) {
    assert.equal(row.kind, "system", `${row.id} in the system scope`);
    assert(!row.id.startsWith("a-"), row.id);
  }
  for (const key of ["suites", "image_suites"])
    for (const row of JSON.parse(lines[key]).include)
      assert(!row.id.startsWith("a-"), `${key} leaked ${row.id}`);
  const component = run(["--scope", "component", "--all"], "component");
  const componentLines = Object.fromEntries(
    readFileSync(component.output, "utf8")
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  const componentSystem = JSON.parse(componentLines.system_suites);
  assert(componentSystem.include.length > 0);
  for (const row of componentSystem.include)
    assert.equal(row.kind, "component", `${row.id} in component scope`);
  assert.notEqual(
    run(["--scope", "sideways", "--all"], "sideways").result.status,
    0,
    "an unknown scope must fail",
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

test("the CLI build inventory includes every resolved build", (t) => {
  const directory = mkdtempSync(
    resolve(temporaryStorageRoot(), "antnest-ci-builds-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = resolve(directory, "bin");
  mkdirSync(bin);
  writeFileSync(resolve(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const output = resolve(directory, "output");
  const result = spawnSync(
    process.execPath,
    [
      "tests/support/ci-changes.mjs",
      "--scope",
      "system",
      "--all",
      "--resolve-images",
      "--all-images",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        PATH: `${bin}:${process.env.PATH}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  const builds = JSON.parse(lines.builds).include;
  const names = builds.map((image) => image.name);
  assert(names.length > 0, "every missing image must be built");
  assert.equal(new Set(names).size, names.length, "no duplicate builds");
  for (const name of Object.keys(images).filter((name) => !isPublishable(name)))
    assert(names.includes(name), `test image ${name} is always built`);
  const resolved = JSON.parse(lines.images);
  const resolvedBuilds = Object.keys(resolved).filter(
    (name) => resolved[name].build,
  );
  assert.deepEqual(
    [...names].sort(),
    [...resolvedBuilds].sort(),
    "builds include every resolved build exactly once",
  );
  assert.deepEqual(
    Object.keys(resolved).sort(),
    suiteImages([], { allImages: true }),
    "a main version set covers every image",
  );
});
