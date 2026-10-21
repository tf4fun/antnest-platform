import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureEnvironment } from "../../support/authenticated-e2e.mjs";
import { composeConfig } from "../../support/compose-config.mjs";
import { composeArgs } from "../../e2e/lifecycle-closeout/docker.mjs";

const gateName = "acp-prompt-gate";
const project = "antnest-lifecycle-1234abcd";
const overlays = [
  "-f",
  "tests/e2e/workspace-closeout/c4.compose.yaml",
  "-f",
  "tests/e2e/agent-ui/receipt-contract.compose.yaml",
];
const invocation = composeArgs(project, [...overlays, "config"]);
const files = invocation.flatMap((argument, index) =>
  argument === "-f" ? [invocation[index + 1]] : [],
);

function environment(octet = 187) {
  return {
    ...fixtureEnvironment({}, { project, octet }),
    ANTNEST_POSTGRES_HOST_PORT: "43109",
    ANTNEST_EDGE_HOST_PORT: "43110",
    ANTNEST_JAEGER_UI_HOST_PORT: "43111",
    ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "43112",
    ANTNEST_EDGE_PUBLIC_BASE_URL: "http://127.0.0.1:43110",
    ANTNEST_C4_CONTROL_DYNAMIC_RANGE: `10.242.${octet}.128/25`,
    ANTNEST_C4_RUNTIME_DYNAMIC_RANGE: `10.243.${octet}.128/25`,
    ANTNEST_C4_AGENT_UI_IMAGE: "antnest/agent-ui:receipt-gate-contract",
    ANTNEST_C4_AGENT_ACP_IMAGE:
      "antnest/agent-acp-service:receipt-gate-contract",
    ANTNEST_C4_EDGE_GATEWAY_IMAGE: "antnest/edge-gateway:receipt-gate-contract",
    ANTNEST_RECEIPT_E2E_IDENTITY_IMAGE:
      "antnest/identity-service:receipt-gate-contract",
    ANTNEST_RECEIPT_E2E_RC_IMAGE:
      "antnest/runtime-controller:receipt-gate-contract",
  };
}

let rendered;
function configuration() {
  rendered ??= composeConfig(files, environment());
  return rendered;
}

function gate(config = configuration()) {
  const value = config.services[gateName];
  assert(value, "receipt integration must declare acp-prompt-gate");
  return value;
}

function hosts(value) {
  if (!Array.isArray(value)) return value ?? {};
  return Object.fromEntries(
    value.map((entry) => {
      const separator = entry.includes("=") ? "=" : ":";
      const offset = entry.indexOf(separator);
      assert(offset > 0, "invalid Compose extra_hosts entry");
      return [entry.slice(0, offset), entry.slice(offset + 1)];
    }),
  );
}

test("receipt gate wiring uses the actual receipt runner's complete Compose overlay order", () => {
  assert.deepEqual(files, [
    "compose.yaml",
    "tests/support/compose.public-development-secrets.yaml",
    "compose.debug.yaml",
    "compose.stage3.yaml",
    "tests/e2e/lifecycle-closeout/compose.yaml",
    "tests/e2e/workspace-closeout/c4.compose.yaml",
    "tests/e2e/agent-ui/receipt-contract.compose.yaml",
  ]);
  gate();
});

test("receipt gate joins only the existing private workspace network at an unused fixed address", () => {
  for (const octet of [187, 188]) {
    const config =
      octet === 187
        ? configuration()
        : composeConfig(files, environment(octet));
    const value = gate(config);
    const address = `10.244.${octet}.8`;
    assert.deepEqual(Object.keys(value.networks), ["edge"]);
    assert.equal(value.networks.edge.ipv4_address, address);
    assert.equal(config.networks.edge.internal, true);
    assert.equal(
      config.networks.edge.driver_opts[
        "com.docker.network.bridge.gateway_mode_ipv4"
      ],
      "isolated",
    );
    for (const [name, service] of Object.entries(config.services)) {
      if (name === gateName) continue;
      for (const binding of Object.values(service.networks ?? {}))
        assert.notEqual(
          binding?.ipv4_address,
          address,
          `${name} address collision`,
        );
    }
  }
});

test("receipt gate publishes one dynamic loopback control port without opening other listeners", () => {
  const value = gate();
  assert.equal(value.ports.length, 1);
  const [binding] = value.ports;
  assert.equal(binding.host_ip, "127.0.0.1");
  assert.equal(binding.target, 8080);
  assert.equal(binding.protocol, "tcp");
  assert.equal(Object.hasOwn(binding, "published"), false);
  assert.equal(value.network_mode, undefined);
});

test("receipt gate imports the capture-enabled transparent gate against the pinned ACP workspace listener", () => {
  const value = gate();
  assert.deepEqual(hosts(value.extra_hosts), {
    "agent-acp-workspace": "10.244.187.5",
  });
  assert(Array.isArray(value.command));
  assert.equal(value.command[0], "node");
  assert(value.command.includes("--input-type=module"));
  const inline = value.command.indexOf("-e");
  assert(
    inline >= 0,
    "receipt gate must import the configurable gate instead of its legacy CLI",
  );
  const script = value.command[inline + 1];
  assert.equal(typeof script, "string");
  assert.match(script, /\bimport\b/u);
  assert.match(script, /["']\/tests\/e2e\/agent-ui\/acp-gate\.mjs["']/u);
  assert.match(
    script,
    /\bcreateAcpGate\(\s*["']http:\/\/agent-acp-workspace:8080["']\s*,\s*\{\s*capture\s*:\s*true\s*[,}]/u,
  );
  assert.match(script, /\.listen\(\s*8080\s*,\s*["']0\.0\.0\.0["']\s*\)/u);
});

test("receipt gate mounts only read-only test sources and receives no service credentials", () => {
  const value = gate();
  assert.equal(value.volumes.length, 1);
  const [mount] = value.volumes;
  assert.equal(mount.type, "bind");
  assert.equal(
    mount.source,
    fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, ""),
  );
  assert.equal(mount.target, "/tests");
  assert.equal(mount.read_only, true);
  assert.deepEqual(value.environment ?? {}, {});
  assert.deepEqual(value.env_file ?? [], []);
  assert.deepEqual(value.secrets ?? [], []);
  assert.deepEqual(value.configs ?? [], []);
});

test("receipt startup waits for real ACP health before gate health and UI admission", () => {
  const config = configuration();
  const value = gate(config);
  assert.equal(
    value.depends_on["agent-acp-service"].condition,
    "service_healthy",
  );
  assert.notEqual(value.depends_on["agent-acp-service"].required, false);
  assert.equal(
    config.services["agent-ui"].depends_on[gateName].condition,
    "service_healthy",
  );
  assert.notEqual(
    config.services["agent-ui"].depends_on[gateName].required,
    false,
  );
  assert.notEqual(value.healthcheck?.disable, true);
  assert(Array.isArray(value.healthcheck?.test));
  assert.match(
    value.healthcheck.test.join(" "),
    /http:\/\/127\.0\.0\.1:8080\/__fault\/state/u,
  );
});

test("receipt UI redirects only ACP traffic while keeping Identity, Controller and workload authorization", () => {
  const config = configuration();
  gate(config);
  const baseline = composeConfig(files.slice(0, -1), environment());
  const actual = config.services["agent-ui"];
  const original = baseline.services["agent-ui"];
  assert.equal(
    actual.environment.ANTNEST_AGENT_ACP_SERVICE_URL,
    "http://acp-prompt-gate:8080",
  );
  assert.deepEqual(actual.environment, {
    ...original.environment,
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://acp-prompt-gate:8080",
  });
  assert.deepEqual(actual.volumes, original.volumes);
  assert.deepEqual(actual.extra_hosts, original.extra_hosts);
  assert.deepEqual(actual.networks, original.networks);
  for (const service of [
    "identity-service",
    "agent-controller",
    "agent-acp-service",
  ])
    assert.deepEqual(
      config.services[service].environment,
      baseline.services[service].environment,
    );
  assert.equal(actual.environment.ANTNEST_SERVICE_AUTH_MODE, "token");
  assert.equal(
    actual.environment.ANTNEST_SERVICE_AUTH_CALLERS_FILE,
    "/etc/antnest/service-auth/callers.json",
  );
  assert.equal(
    actual.environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR,
    "/etc/antnest/service-auth/tokens",
  );
});
