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
};

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
