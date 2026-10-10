import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { composeConfig } from "../../support/compose-config.mjs";

const root = new URL("../../../", import.meta.url);

test("loopback Compose keeps Secure cookies and one explicit public origin", () => {
  const config = composeConfig(["compose.yaml"], {
    ANTNEST_EDGE_PUBLIC_BASE_URL: "http://127.0.0.1:43110",
  });
  const gateway = config.services["edge-gateway"].environment;
  assert.equal(gateway.ANTNEST_EDGE_COOKIE_SECURE, "true");
  assert.equal(gateway.ANTNEST_EDGE_PUBLIC_ORIGIN, "http://127.0.0.1:43110");
  assert.equal(
    config.services["identity-service"].environment
      .ANTNEST_IDENTITY_PUBLIC_BASE_URL,
    gateway.ANTNEST_EDGE_PUBLIC_ORIGIN,
  );
});

for (const mode of ["native", "proxy"]) {
  test(`${mode} HTTPS reference has one public TLS port and an explicit trust boundary`, () => {
    const config = composeConfig(
      [
        "compose.yaml",
        mode === "native" ? "compose.native-tls.yaml" : "compose.tls.yaml",
      ],
      {
        ANTNEST_EDGE_PUBLIC_BASE_URL: "https://antnest.example:8443",
        ANTNEST_EDGE_TLS_DIRECTORY: "/never-mounted-tls",
        ANTNEST_EDGE_TLS_HOST_PORT: "8443",
      },
    );
    const gateway = config.services["edge-gateway"];
    assert.equal(
      gateway.environment.ANTNEST_EDGE_PUBLIC_ORIGIN,
      "https://antnest.example:8443",
    );
    assert.equal(gateway.environment.ANTNEST_EDGE_COOKIE_SECURE, "true");
    assert.equal(
      config.services["identity-service"].environment
        .ANTNEST_IDENTITY_PUBLIC_BASE_URL,
      gateway.environment.ANTNEST_EDGE_PUBLIC_ORIGIN,
    );
    const publicService =
      mode === "native" ? gateway : config.services["tls-proxy"];
    assert.deepEqual(
      publicService.ports.map(({ host_ip, published, target }) => [
        host_ip,
        published,
        target,
      ]),
      [["0.0.0.0", "8443", mode === "native" ? 8080 : 8443]],
    );
    const certificates = publicService.volumes.find(
      (volume) => volume.target === "/etc/antnest/public-tls",
    );
    assert.equal(certificates.source, "/never-mounted-tls");
    assert.equal(certificates.read_only, true);
    // Some Compose versions omit false-valued bind fields in rendered JSON.
    assert.equal(certificates.bind.create_host_path ?? false, false);
    if (mode === "native") {
      assert.equal(
        gateway.environment.ANTNEST_EDGE_TLS_CERT_FILE,
        "/etc/antnest/public-tls/cert.pem",
      );
      assert.equal(
        gateway.environment.ANTNEST_EDGE_TLS_KEY_FILE,
        "/etc/antnest/public-tls/key.pem",
      );
      assert.equal(gateway.environment.ANTNEST_EDGE_TRUSTED_PROXIES, "");
    } else {
      assert.deepEqual(gateway.ports ?? [], []);
      assert.equal(config.networks["gateway-ingress"].internal, true);
      const proxyIP = publicService.networks["gateway-ingress"].ipv4_address;
      assert.equal(
        gateway.environment.ANTNEST_EDGE_TRUSTED_PROXIES,
        `${proxyIP}/32`,
      );
      assert.equal(gateway.environment.ANTNEST_EDGE_TLS_CERT_FILE, undefined);
    }
  });
}

test("deployment example uses generated authentication and separated purpose addresses", async () => {
  const env = parseEnv(await readFile(new URL(".env.example", root), "utf8"));
  for (const field of [
    "ANTNEST_SKILL_REGISTRY_API_TOKEN",
    "ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN",
    "ANTNEST_JAEGER_RUNTIME_IPV4",
    "ANTNEST_AGENT_ACP_SERVICE_URL",
  ])
    assert.equal(env[field], undefined, `retired deployment channel ${field}`);
  assert.equal(env.ANTNEST_SERVICE_NETWORK_PREFIX, "10.241.0");
  assert.equal(env.ANTNEST_RUNTIME_OTLP_INGRESS_IPV4, "172.30.255.4");
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_MANAGEMENT_IPV4, "172.30.255.5");
  assert.equal(env.ANTNEST_ACP_MANAGEMENT_IPV4, "172.30.255.6");
  assert.equal(env.ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE, "172.30.255.128/25");
  assert.equal(env.ANTNEST_AGENT_CONTROLLER_CONTROL_IPV4, "172.31.255.4");
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_CONTROL_IPV4, "172.31.255.5");
  assert.equal(env.ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS, "false");
});

test("every fixed Compose address is set by the deployment example", async () => {
  const env = parseEnv(await readFile(new URL(".env.example", root), "utf8"));
  const compose = await readFile(new URL("compose.yaml", root), "utf8");
  const variables = new Set(
    [...compose.matchAll(/\$\{(ANTNEST_[A-Z_]+_IPV4):-/g)].map(
      ([, name]) => name,
    ),
  );
  assert(variables.size > 0);
  for (const name of variables)
    assert.notEqual(env[name], undefined, `${name} is missing`);
});

test("standard Compose cannot inherit Skill learning debug settings", async () => {
  const compose = await readFile(new URL("compose.yaml", root), "utf8");
  for (const variable of [
    "ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS",
    "ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID",
  ])
    assert(
      !compose.includes(variable),
      `${variable} belongs only in E2E Compose`,
    );
});

test("Skill learning E2E Compose explicitly supplies the development gate and debug Agent", async () => {
  const compose = await readFile(
    new URL("tests/e2e/skill-learning/compose.yaml", root),
    "utf8",
  );
  for (const variable of [
    "ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS",
    "ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID",
  ])
    assert(compose.includes(variable), `missing E2E setting ${variable}`);
});

test("deployment example names every service-owned database password and encryption key", async () => {
  const env = parseEnv(await readFile(new URL(".env.example", root), "utf8"));
  for (const key of [
    "ANTNEST_POSTGRES_ADMIN_PASSWORD",
    "ANTNEST_EGRESS_POSTGRES_PASSWORD",
    "ANTNEST_RUNTIME_CONTROLLER_POSTGRES_PASSWORD",
    "ANTNEST_AGENT_ACP_POSTGRES_PASSWORD",
    "ANTNEST_IDENTITY_POSTGRES_PASSWORD",
    "ANTNEST_AGENT_CONTROLLER_POSTGRES_PASSWORD",
    "ANTNEST_SKILL_REGISTRY_POSTGRES_PASSWORD",
    "ANTNEST_TEMPORAL_POSTGRES_PASSWORD",
    "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD",
    "ANTNEST_IDENTITY_ENCRYPTION_KEY",
    "ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY",
    "ANTNEST_ACP_CLIENT_MCP_KEY",
  ])
    assert.equal(env[key], "", `secret placeholder ${key}`);
  for (const key of [
    "ANTNEST_IDENTITY_ENCRYPTION_KEY",
    "ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY",
    "ANTNEST_ACP_CLIENT_MCP_KEY",
  ])
    assert.equal(env[key], "", `secret placeholder ${key}`);
  assert.equal(
    env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    "antnest/antnest-runtime:local",
  );
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_SCOPE, env.COMPOSE_PROJECT_NAME);
  assert.equal(
    env.ANTNEST_EDGE_PUBLIC_BASE_URL,
    `http://127.0.0.1:${env.ANTNEST_EDGE_HOST_PORT}`,
  );
  assert(env.ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME);
  assert(env.ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT);
  assert.equal(
    env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT,
    "false",
    "production example must not enable body diagnostics by default",
  );
});

test("Docker context excludes local integration credentials, including nested service copies", async () => {
  const patterns = (
    await readFile(new URL(".dockerignore", root), "utf8")
  ).split(/\r?\n/);
  for (const pattern of ["**/.secret", "**/auth.json", "**/.env", "**/.env.*"])
    assert(
      patterns.includes(pattern),
      `missing credential exclusion ${pattern}`,
    );
  assert(patterns.indexOf("!**/.env.example") > patterns.indexOf("**/.env.*"));
});

test("Git excludes credential files while retaining the public configuration example", async () => {
  const patterns = (await readFile(new URL(".gitignore", root), "utf8")).split(
    /\r?\n/,
  );
  for (const pattern of [".secret", "auth.json", ".env", ".env.*"])
    assert(
      patterns.includes(pattern),
      `missing Git credential exclusion ${pattern}`,
    );
  assert(patterns.indexOf("!.env.example") > patterns.indexOf(".env.*"));
});
