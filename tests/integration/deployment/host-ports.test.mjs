import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { parse } = require("yaml");
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/platform/development-authentication-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
).host_ports;
const profiles = [
  "stage2",
  "stage3",
  "stage2-e2e",
  "stage3-e2e",
  "observability",
];

function render(files, overrides = {}) {
  // Never resolve a retained .env file or inherited deployment credentials.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(key),
    ),
  );
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-name",
      "antnest-port-contract",
      ...files.flatMap((file) => ["-f", file]),
      ...profiles.flatMap((profile) => ["--profile", profile]),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: root,
      env: {
        ...env,
        COMPOSE_DISABLE_ENV_FILE: "1",
        ANTNEST_SERVICE_AUTH_DIRECTORY: "/never-mounted-deployment-credentials",
        ANTNEST_SERVICE_AUTH_UID: "65532",
        ANTNEST_SERVICE_AUTH_GID: "65532",
        ANTNEST_IDENTITY_CCT_SIGNING_KID: "port-contract-unused",
        ...overrides,
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function publications(config) {
  return Object.fromEntries(
    Object.entries(config.services).flatMap(([name, service]) =>
      service.ports?.length ? [[name, service.ports]] : [],
    ),
  );
}

function assertPublications(config, expected, overrides = {}) {
  const ports = publications(config);
  assert.deepEqual(Object.keys(ports).sort(), Object.keys(expected).sort());
  for (const [
    name,
    { target, environment, default: defaultPort },
  ] of Object.entries(expected)) {
    assert.equal(ports[name].length, 1, name);
    const [port] = ports[name];
    assert.equal(port.host_ip, contract.host_ip, name);
    assert.equal(port.target, target, name);
    assert.equal(
      port.published,
      overrides[environment] ?? String(defaultPort),
      name,
    );
    assert.equal(port.protocol, "tcp", name);
  }
}

test("base Compose publishes only Gateway even when every profile is enabled", () => {
  assertPublications(render([contract.base_file]), contract.base_publications);
});

test("diagnostic port variables cannot publish internal services from the base", () => {
  const overrides = Object.fromEntries(
    Object.values({
      ...contract.base_publications,
      ...contract.debug_publications,
    }).map(({ environment }, index) => [environment, String(31000 + index)]),
  );
  assertPublications(
    render([contract.base_file], overrides),
    contract.base_publications,
    overrides,
  );
});

test("debug Compose publishes exactly its declared diagnostics on loopback", () => {
  const base = render([contract.base_file]);
  const debug = render([contract.base_file, contract.debug_file]);
  assertPublications(debug, {
    ...contract.base_publications,
    ...contract.debug_publications,
  });
  for (const [name, service] of Object.entries(base.services)) {
    const { ports: basePorts, ...baseRest } = service;
    const { ports: debugPorts, ...debugRest } = debug.services[name];
    assert.deepEqual(
      debugRest,
      baseRest,
      `${name} diagnostic overlay changes only ports`,
    );
    void basePorts;
    void debugPorts;
  }
  const source = parse(
    readFileSync(
      new URL("../../../compose.debug.yaml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(source), ["services"]);
  for (const service of Object.values(source.services))
    assert.deepEqual(Object.keys(service), ["ports"]);
});

test("debug overrides allow isolated assigned ports without publishing health or MCP", () => {
  const overrides = Object.fromEntries(
    Object.values(contract.debug_publications).map(({ environment }) => [
      environment,
      "0",
    ]),
  );
  assertPublications(
    render([contract.base_file, contract.debug_file], overrides),
    {
      ...contract.base_publications,
      ...contract.debug_publications,
    },
    overrides,
  );
});

test("stage3 suppresses application diagnostics when applied after debug", () => {
  const expected = {
    ...contract.base_publications,
    ...contract.debug_publications,
  };
  for (const service of contract.stage3_suppressed_debug_services)
    delete expected[service];
  assertPublications(
    render([contract.base_file, contract.debug_file, "compose.stage3.yaml"]),
    expected,
  );
});

test("debug applied last is an explicit choice to expose application diagnostics", () => {
  assertPublications(
    render([contract.base_file, "compose.stage3.yaml", contract.debug_file]),
    {
      ...contract.base_publications,
      ...contract.debug_publications,
    },
  );
});
