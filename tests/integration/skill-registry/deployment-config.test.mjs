import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composeConfig } from "../../support/compose-config.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "der" })
  .toString("base64");
const verifiers = JSON.stringify({
  keys: [
    {
      kid: "deployment-fixture",
      algorithm: "Ed25519",
      public_key_base64url: keys.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64url"),
    },
  ],
});
const registryToken = "deployment-registry-fixture-at-least-32-bytes";
const sourceToken = "deployment-source-fixture-at-least-32-bytes";

function render(extra = {}) {
  return composeConfig(["compose.yaml", "compose.stage3.yaml"], extra).services;
}

const configured = () =>
  render({
    ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "deployment-fixture",
    ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: privateKey,
    ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: verifiers,
  });
function disabled(services) {
  const acp = services["agent-acp-service"].environment;
  const registry = services["skill-registry"].environment;
  for (const field of [
    "ANTNEST_ACP_SKILL_REGISTRY_URL",
    "ANTNEST_ACP_SKILL_REGISTRY_TOKEN",
    "ANTNEST_ACP_SKILL_SOURCE_TOKEN",
  ])
    assert(!acp[field], `${field} must remain disabled`);
  for (const field of [
    "ANTNEST_SKILL_REGISTRY_SOURCE_URL",
    "ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN",
  ])
    assert(!registry[field], `${field} must remain disabled`);
}

test("default Compose keeps source discovery disabled and formal Registry available", () => {
  const services = render();
  disabled(services);
  assert(
    services["skill-registry"].environment.ANTNEST_SERVICE_AUTH_MODE ===
      "token",
  );
  assert.equal(
    services["skill-registry"].environment.ANTNEST_IDENTITY_URL,
    "http://identity-service:8080",
  );
  assert(
    !services["agent-acp-service"].environment
      .ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL,
  );
  assert(
    !services["runtime-controller"].environment
      .ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS,
  );
});

test("maintenance enables authenticated source origins and preserves signer/public-verifier separation", () => {
  const services = configured();
  const acp = services["agent-acp-service"].environment;
  const registry = services["skill-registry"].environment;
  const rc = services["runtime-controller"].environment;
  assert.equal(
    acp.ANTNEST_ACP_SKILL_REGISTRY_URL,
    "http://skill-registry:8080",
  );
  assert.equal(
    registry.ANTNEST_SKILL_REGISTRY_SOURCE_URL,
    "http://agent-acp-workspace:8080",
  );
  assert.equal(
    acp.ANTNEST_SERVICE_AUTH_TOKEN_DIR,
    "/etc/antnest/service-auth/tokens",
  );
  assert.equal(
    registry.ANTNEST_SERVICE_AUTH_TOKEN_DIR,
    "/etc/antnest/service-auth/tokens",
  );
  for (const environment of [acp, registry, rc])
    for (const field of [
      "ANTNEST_SKILL_REGISTRY_API_TOKEN",
      "ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN",
      "ANTNEST_ACP_SKILL_REGISTRY_TOKEN",
      "ANTNEST_ACP_SKILL_SOURCE_TOKEN",
    ])
      assert(!environment[field], `retired credential ${field}`);
  assert(
    acp.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY === privateKey,
    "signing key must reach only its owning ACP service",
  );
  assert.equal(
    acp.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID,
    "deployment-fixture",
  );
  assert(
    rc.ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS === verifiers,
    "RC must receive the exact public verifier set",
  );
  assert.equal(
    acp.ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL,
    "http://agent-controller:8080",
  );
  for (const [name, service] of Object.entries(services))
    if (name !== "agent-acp-service")
      assert(
        !JSON.stringify(service.environment ?? {}).includes(privateKey),
        "a non-owning service received private signing material",
      );
});

test("Runtime public verifier configuration alone cannot activate ACP learning or discovery", () => {
  const services = render({
    ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: verifiers,
  });
  disabled(services);
  assert.equal(
    services["agent-acp-service"].environment
      .ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL,
    "",
  );
});

test("retired host tokens never install authority or activate source discovery", () => {
  const services = render({
    ANTNEST_SKILL_REGISTRY_API_TOKEN: registryToken,
    ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN: sourceToken,
  });
  disabled(services);
  assert(
    !services["skill-registry"].environment.ANTNEST_SKILL_REGISTRY_API_TOKEN,
  );
});

test("the real deployment keeps Registry outside Runtime/Egress and source credentials outside Agent UI", () => {
  const services = configured();
  const registry = services["skill-registry"];
  assert.deepEqual(Object.keys(registry.networks).sort(), [
    "edge",
    "identity-clients",
    "observability",
    "registry-clients",
    "skill-registry-database",
  ]);
  assert(!registry.ports?.length);
  assert(!services["agent-acp-service"].ports?.length);
  assert(
    !JSON.stringify(services["agent-ui"].environment).includes(sourceToken),
    "source bearer must not reach Bridge or frontend",
  );
  assert(
    !JSON.stringify(services["agent-ui"].environment).includes(privateKey),
    "signing key must not reach Bridge or frontend",
  );
});

test("the standard Stage 3 build includes the Registry image required by deployment", () => {
  const plan = execFileSync("make", ["--dry-run", "docker-build-stage3"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert(
    /^docker compose --profile stage3 build skill-registry$/mu.test(plan),
    "the normal build must include Skill Registry before starting a clean deployment",
  );
});

test("Registry tracing is disabled by default with its own canonical service resource", () => {
  const registry = render()["skill-registry"].environment;
  assert.equal(registry.OTEL_SDK_DISABLED, "true");
  assert.equal(registry.OTEL_SERVICE_NAME, "skill-registry");
  assert.equal(registry.OTEL_EXPORTER_OTLP_ENDPOINT, "http://jaeger:4318");
  assert.equal(registry.OTEL_TRACES_EXPORTER, "");
});

test("standard Compose passes Registry the shared and trace-specific exporter settings without enabling source discovery", () => {
  const settings = {
    OTEL_SDK_DISABLED: "false",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://trace-collector.invalid:4318",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
      "http://trace-specific.invalid:4318/v1/traces",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
  };
  const services = render(settings);
  const registry = services["skill-registry"].environment;
  for (const [key, value] of Object.entries(settings))
    assert.equal(registry[key], value, key);
  assert.equal(registry.OTEL_SERVICE_NAME, "skill-registry");
  disabled(services);
  assert.deepEqual(Object.keys(services["skill-registry"].networks).sort(), [
    "edge",
    "identity-clients",
    "observability",
    "registry-clients",
    "skill-registry-database",
  ]);
  assert(!services["skill-registry"].ports?.length);
});
