import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixtureEnvironment } from "../../support/authenticated-e2e.mjs";
import { composeConfig } from "../../support/compose-config.mjs";
import { durablePath } from "../../support/storage.mjs";

const runner = readFileSync(
  new URL("../../e2e/e2e-stage3a.sh", import.meta.url),
  "utf8",
);
const composeFunction = runner.match(/^compose\(\) \{\n[\s\S]*?^\}/mu)?.[0];
assert(composeFunction, "Stage 3a Compose dispatch must be inspectable");
const ranges = [
  ...runner.matchAll(/^\s*export (ANTNEST_\w+_DYNAMIC_RANGE=.+)$/gmu),
]
  .map((match) => `export ${match[1]}`)
  .join("\n");
const selectors = [
  "managed_mcp",
  "base_profile",
  "session_cost",
  "multimodal",
  "tool_permissions",
  "slash_commands",
  "structured_plan",
  "file_observations",
  "tool_progress",
  "acp_restart",
  "acp_persistence",
  "rpc_response_loss",
];
const cases = [
  ...selectors.map((name) => [name, { [name]: "true" }]),
  ...["identity-http", "acp-session", "agent-access", "acp-closeout"].map(
    (name) => [name, { tool_profile: name }],
  ),
  ...[
    "SKILL_MOUNT_RACE",
    "SKILL_INITIALIZE_RACE",
    "SKILL_START_RESPONSE_LOSS",
  ].map((name) => [
    name.toLowerCase(),
    { base_profile: "true", [`ANTNEST_E2E_${name}`]: "true" },
  ]),
  ["default", { tool_profile: "default" }],
];
const environment = {
  ...fixtureEnvironment({}, { project: "antnest-stage3-e2e-109", octet: 187 }),
  ANTNEST_POSTGRES_HOST_PORT: "43109",
  ANTNEST_EDGE_HOST_PORT: "43110",
  ANTNEST_JAEGER_UI_HOST_PORT: "43111",
  ANTNEST_OIDC_TEST_PORT: "43112",
  ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "43113",
  ANTNEST_EDGE_PUBLIC_BASE_URL: "http://127.0.0.1:43110",
  ANTNEST_E2E_RUN_ID: "overlay-contract",
  ANTNEST_ADMISSION_TAG: "session-overlay-contract",
};

test("HTTPS workspace consumers can select the current Controller candidate", () => {
  const image = "antnest/agent-controller:current-browser-contract";
  const config = composeConfig(
    [
      "compose.yaml",
      "compose.debug.yaml",
      "tests/e2e/lifecycle-closeout/compose.yaml",
      "tests/e2e/workspace-closeout/c4.compose.yaml",
    ],
    {
      ...environment,
      ANTNEST_C4_CONTROL_DYNAMIC_RANGE: "10.242.187.128/25",
      ANTNEST_C4_RUNTIME_DYNAMIC_RANGE: "10.243.187.128/25",
      ANTNEST_C4_AGENT_CONTROLLER_IMAGE: image,
    },
  );
  assert.equal(config.services["agent-controller"].image, image);
});

function dispatch(selection, action) {
  const result = spawnSync(
    "/bin/sh",
    [
      "-eu",
      "-c",
      `${ranges}
${composeFunction}
docker() {
  "$OVERLAY_NODE" -e 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),ranges:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.endsWith("_DYNAMIC_RANGE")))}))' -- "$@"
}
compose "$OVERLAY_ACTION"`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        OVERLAY_NODE: process.execPath,
        OVERLAY_ACTION: action,
        network_octet: "187",
        tool_profile: "",
        ...Object.fromEntries(selectors.map((name) => [name, "false"])),
        ...selection,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(result.stdout);
  return {
    files: captured.args.flatMap((arg, index) =>
      arg === "-f" ? [captured.args[index + 1]] : [],
    ),
    ranges: captured.ranges,
  };
}

function verify(
  config,
  name,
  { identity = false, model = false, dynamic = true } = {},
) {
  const actual = Object.entries(config.services).flatMap(([service, value]) =>
    (value.ports ?? []).map(({ host_ip, published, target, protocol }) => [
      service,
      host_ip,
      published,
      target,
      protocol,
    ]),
  );
  const expected = [
    ["edge-gateway", "127.0.0.1", "43110", 8080, "tcp"],
    ["diagnostic-relay", "127.0.0.1", "43109", 5432, "tcp"],
    ["diagnostic-relay", "127.0.0.1", "43111", 16686, "tcp"],
  ];
  if (identity)
    expected.push(["oidc-fixture", "127.0.0.1", "43112", 8443, "tcp"]);
  if (model) expected.push(["stage3-model", "127.0.0.1", "43113", 8080, "tcp"]);
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    `${name}: exact isolated publications`,
  );
  if (dynamic) {
    assert.deepEqual(config.networks.control.ipam.config, [
      { subnet: "10.242.187.0/24", ip_range: "10.242.187.128/25" },
    ]);
    assert.deepEqual(config.networks["runtime-management"].ipam.config, [
      { subnet: "10.243.187.0/24", ip_range: "10.243.187.128/25" },
    ]);
  }
  const output = process.env.ANTNEST_OVERLAY_EVIDENCE_DIRECTORY;
  if (output) {
    const directory = durablePath(output);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${name}.json`),
      JSON.stringify(config, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
}

for (const [name, selection] of cases) {
  test(`Stage 3a ${name} keeps diagnostics and dynamic allocation isolated`, () => {
    const selected = dispatch(selection, "config");
    assert.deepEqual(
      dispatch(selection, "up"),
      selected,
      "startup and later commands use the same overlays",
    );
    verify(
      composeConfig(selected.files, { ...environment, ...selected.ranges }),
      name,
      {
        identity: Boolean(selection.tool_profile && name !== "default"),
        dynamic: name !== "default",
      },
    );
  });
}

for (const [name, selection] of [
  ["base", { base_profile: "true" }],
  ["identity", { tool_profile: "identity-http" }],
]) {
  test(`Stage 3a ${name} uses isolated browser-session candidate images`, () => {
    const selected = dispatch(selection, "config");
    const candidates = {
      "edge-gateway": ["GATEWAY", "gateway"],
      "identity-service": ["IDENTITY", "identity"],
      "agent-ui": ["AGENT_UI", "agent-ui"],
      "admin-console": ["CONSOLE", "console"],
    };
    const overrides = Object.fromEntries(
      Object.values(candidates).map(([variable, image]) => [
        `ANTNEST_E2E_${variable}_IMAGE`,
        `antnest/e2e-session-${image}:isolated-contract`,
      ]),
    );
    const config = composeConfig(selected.files, {
      ...environment,
      ...selected.ranges,
      ...overrides,
    });
    for (const [service, [variable]] of Object.entries(candidates)) {
      assert.equal(
        config.services[service].image,
        overrides[`ANTNEST_E2E_${variable}_IMAGE`],
        `${service} must use this run's candidate without replacing local tags`,
      );
    }
  });
}

test("Identity diagnostic polling can differ without changing retained deployment", () => {
  const selected = dispatch({ tool_profile: "identity-http" }, "config");
  const key = "ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL";
  const overrides = {
    ANTNEST_E2E_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL: "100ms",
  };
  const configured = composeConfig(selected.files, {
    ...environment,
    ...selected.ranges,
    ...overrides,
  });
  assert.equal(
    configured.services["agent-controller"].environment[key],
    "100ms",
  );
  const defaults = composeConfig(selected.files, {
    ...environment,
    ...selected.ranges,
  });
  assert.equal(defaults.services["agent-controller"].environment[key], "2s");
  const retained = composeConfig(["compose.yaml"], {
    ...environment,
    ...overrides,
  });
  assert.equal(
    retained.services["agent-controller"].environment[key],
    undefined,
  );
});

test("ACP Session appends the admission overlay for all service candidates and both Identity rebuilds", () => {
  const selected = dispatch({ tool_profile: "acp-session" }, "config");
  const admission = "tests/integration/deployment/compose.admission.yaml";
  assert.equal(selected.files.at(-1), admission);
  for (const profile of ["identity-http", "agent-access", "acp-closeout"])
    assert(
      !dispatch({ tool_profile: profile }, "config").files.includes(admission),
    );
  const child = readFileSync(
    new URL("../../e2e/e2e-acp-session.sh", import.meta.url),
    "utf8",
  );
  const childCompose = child.match(/^compose\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert(childCompose);
  const files = [...childCompose.matchAll(/-f ([\w./-]+)(?:\s|$)/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(files, selected.files);
  for (const ttl of ["12h", "5s"]) {
    const config = composeConfig(selected.files, {
      ...environment,
      ...selected.ranges,
      ANTNEST_IDENTITY_ACCESS_TOKEN_TTL: ttl,
    });
    for (const name of [
      "admin-console",
      "agent-acp-service",
      "agent-controller",
      "agent-ui",
      "edge-gateway",
      "identity-service",
      "runtime-controller",
      "runtime-egress",
      "skill-registry",
      "temporal",
    ])
      assert.equal(
        config.services[name].image,
        `antnest/${name}:session-overlay-contract`,
      );
    assert.equal(
      config.services["runtime-controller"].environment
        .ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
      "antnest/runtime-controller:session-overlay-contract",
    );
    assert.equal(
      config.services["identity-service"].environment
        .ANTNEST_IDENTITY_TOKEN_TTL,
      ttl,
    );
    assert.equal(
      config.services["identity-service"].environment.SSL_CERT_FILE,
      "/test-ca/tls.crt",
    );
    assert(
      config.services["identity-service"].volumes.some(
        (volume) => volume.target === "/test-ca" && volume.read_only,
      ),
    );
  }
});

test("slash commands select current service and preparer candidates without Session fault overlays", () => {
  const selected = dispatch(
    { slash_commands: "true", tool_profile: "slash-commands" },
    "config",
  );
  assert.equal(
    selected.files.at(-1),
    "tests/integration/deployment/compose.admission.yaml",
  );
  assert(!selected.files.some((file) => file.includes("identity-closeout")));
  const config = composeConfig(selected.files, {
    ...environment,
    ...selected.ranges,
    ANTNEST_ADMISSION_TAG: "commands-overlay-contract",
  });
  for (const name of [
    "admin-console",
    "agent-acp-service",
    "agent-controller",
    "agent-ui",
    "edge-gateway",
    "identity-service",
    "runtime-controller",
    "runtime-egress",
    "skill-registry",
    "temporal",
  ])
    assert.equal(
      config.services[name].image,
      `antnest/${name}:commands-overlay-contract`,
    );
  assert.equal(
    config.services["runtime-controller"].environment
      .ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
    "antnest/runtime-controller:commands-overlay-contract",
  );
});

test("structured plans select current service and preparer candidates without Session fault overlays", () => {
  const selected = dispatch(
    { structured_plan: "true", tool_profile: "structured-plan" },
    "config",
  );
  assert.equal(
    selected.files.at(-1),
    "tests/integration/deployment/compose.admission.yaml",
  );
  assert(!selected.files.some((file) => file.includes("identity-closeout")));
  const config = composeConfig(selected.files, {
    ...environment,
    ...selected.ranges,
    ANTNEST_ADMISSION_TAG: "plan-overlay-contract",
  });
  for (const name of [
    "admin-console",
    "agent-acp-service",
    "agent-controller",
    "agent-ui",
    "edge-gateway",
    "identity-service",
    "runtime-controller",
    "runtime-egress",
    "skill-registry",
    "temporal",
  ])
    assert.equal(
      config.services[name].image,
      `antnest/${name}:plan-overlay-contract`,
    );
  assert.equal(
    config.services["runtime-controller"].environment
      .ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
    "antnest/runtime-controller:plan-overlay-contract",
  );
});

test("native multimodal selects current service and preparer candidates without Session fault overlays", () => {
  const selected = dispatch(
    { multimodal: "true", tool_profile: "multimodal" },
    "config",
  );
  assert.equal(
    selected.files.at(-1),
    "tests/integration/deployment/compose.admission.yaml",
  );
  assert(!selected.files.some((file) => file.includes("identity-closeout")));
  const config = composeConfig(selected.files, {
    ...environment,
    ...selected.ranges,
    ANTNEST_ADMISSION_TAG: "multimodal-overlay-contract",
  });
  for (const name of [
    "admin-console",
    "agent-acp-service",
    "agent-controller",
    "agent-ui",
    "edge-gateway",
    "identity-service",
    "runtime-controller",
    "runtime-egress",
    "skill-registry",
    "temporal",
  ])
    assert.equal(
      config.services[name].image,
      `antnest/${name}:multimodal-overlay-contract`,
    );
  assert.equal(
    config.services["runtime-controller"].environment
      .ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
    "antnest/runtime-controller:multimodal-overlay-contract",
  );
});

test("file observations select current service and preparer candidates without Session fault overlays", () => {
  const selected = dispatch(
    { file_observations: "true", tool_profile: "file-observations" },
    "config",
  );
  assert.equal(
    selected.files.at(-1),
    "tests/integration/deployment/compose.admission.yaml",
  );
  assert(!selected.files.some((file) => file.includes("identity-closeout")));
  const config = composeConfig(selected.files, {
    ...environment,
    ...selected.ranges,
    ANTNEST_ADMISSION_TAG: "files-overlay-contract",
  });
  for (const name of [
    "admin-console",
    "agent-acp-service",
    "agent-controller",
    "agent-ui",
    "edge-gateway",
    "identity-service",
    "runtime-controller",
    "runtime-egress",
    "skill-registry",
    "temporal",
  ])
    assert.equal(
      config.services[name].image,
      `antnest/${name}:files-overlay-contract`,
    );
  assert.equal(
    config.services["runtime-controller"].environment
      .ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
    "antnest/runtime-controller:files-overlay-contract",
  );
});

for (const [name, overlay, prefix] of [
  ["foundation", "lifecycle-closeout/foundation.compose.yaml", "LIFECYCLE"],
  ["c4", "workspace-closeout/c4.compose.yaml", "C4"],
]) {
  test(`${name} keeps its lifecycle diagnostics and dynamic allocation isolated`, () => {
    const config = composeConfig(
      [
        "compose.yaml",
        "compose.debug.yaml",
        "compose.stage3.yaml",
        "tests/support/compose.public-development-secrets.yaml",
        "tests/e2e/lifecycle-closeout/compose.yaml",
        `tests/e2e/${overlay}`,
      ],
      {
        ...environment,
        [`ANTNEST_${prefix}_CONTROL_DYNAMIC_RANGE`]: "10.242.187.128/25",
        [`ANTNEST_${prefix}_RUNTIME_DYNAMIC_RANGE`]: "10.243.187.128/25",
      },
    );
    verify(config, name, { model: true });
  });
}
