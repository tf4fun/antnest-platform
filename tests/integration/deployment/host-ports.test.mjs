import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";
import { publicDevelopmentSecrets } from "../../support/public-development-secrets.mjs";

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
  "diagnostics",
];
const topology = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/platform/development-network-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

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
        ...publicDevelopmentSecrets(),
        COMPOSE_DISABLE_ENV_FILE: "1",
        ANTNEST_SERVICE_AUTH_DIRECTORY: "/never-mounted-deployment-credentials",
        ANTNEST_SERVICE_AUTH_UID: "65532",
        ANTNEST_SERVICE_AUTH_GID: "65532",
        ANTNEST_DOCKER_SOCKET_GID: "998",
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
  const diagnostics = Object.keys(expected).filter(
    (name) => name in contract.debug_publications,
  );
  const publishers = Object.keys(expected).filter(
    (name) => name in contract.base_publications,
  );
  if (diagnostics.length) publishers.push(contract.debug_publisher);
  assert.deepEqual(Object.keys(ports).sort(), publishers.sort());
  for (const [
    name,
    { target, environment, default: defaultPort },
  ] of Object.entries(expected)) {
    const diagnostic = diagnostics.includes(name);
    const owner = diagnostic ? contract.debug_publisher : name;
    const wanted = diagnostic
      ? topology.infrastructure.diagnostics.listener_ports[name]
      : target;
    const selected = ports[owner].filter((item) => item.target === wanted);
    assert.equal(selected.length, 1, name);
    const [port] = selected;
    assert.equal(port.host_ip, contract.host_ip, name);
    assert.equal(port.target, wanted, name);
    assert.equal(
      port.published,
      overrides[environment] ?? String(defaultPort),
      name,
    );
    assert.equal(port.protocol, "tcp", name);
  }
  if (diagnostics.length)
    assert.equal(ports[contract.debug_publisher].length, diagnostics.length);
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
    if (name === contract.debug_publisher) {
      delete baseRest.profiles;
      delete debugRest.profiles;
    }
    assert.deepEqual(
      debugRest,
      baseRest,
      `${name} diagnostic overlay changes only relay activation/publication`,
    );
    void basePorts;
    void debugPorts;
  }
  const source = parse(
    readFileSync(
      new URL("../../../compose.debug.yaml", import.meta.url),
      "utf8",
    ),
    { logLevel: "silent" },
  );
  assert.deepEqual(Object.keys(source), ["services"]);
  assert.deepEqual(Object.keys(source.services), [contract.debug_publisher]);
  assert.deepEqual(Object.keys(source.services[contract.debug_publisher]), [
    "profiles",
    "ports",
  ]);
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

test("product stage3 does not silently change an explicitly selected diagnostic relay", () => {
  assertPublications(
    render([contract.base_file, contract.debug_file, "compose.stage3.yaml"]),
    { ...contract.base_publications, ...contract.debug_publications },
  );
});

test("debug explicitly exposes the same diagnostics in either product overlay order", () => {
  assertPublications(
    render([contract.base_file, "compose.stage3.yaml", contract.debug_file]),
    {
      ...contract.base_publications,
      ...contract.debug_publications,
    },
  );
});

test("dependency-only test override publishes only PostgreSQL and Temporal relay ports", () => {
  assertPublications(
    composeConfig([
      contract.base_file,
      contract.debug_file,
      "tests/support/compose.dependencies.yaml",
    ]),
    {
      ...contract.base_publications,
      postgres: contract.debug_publications.postgres,
      temporal: contract.debug_publications.temporal,
    },
  );
});
