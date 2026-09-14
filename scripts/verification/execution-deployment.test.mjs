import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyExecutionDeployment } from "./execution-deployment.mjs";

function fixture() {
  return {
    services: {
      "agent-controller": {
        environment: {
          ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
          ANTNEST_ACP_MAX_CONFIGURATION_BYTES: "16777216",
        },
        depends_on: { postgres: { condition: "service_healthy" } },
        networks: { development: {} },
      },
      "agent-acp-service": {
        environment: {
          ANTNEST_ACP_MAX_CONFIGURATION_BYTES: "16777216",
          ANTNEST_ACP_RUN_TIMEOUT: "30m",
        },
        depends_on: { postgres: { condition: "service_healthy" } },
        networks: { development: {} },
      },
    },
  };
}

test("execution deployment publishes configuration in one direction without startup coupling", () => {
  assert.deepEqual(verifyExecutionDeployment(fixture()), {
    direction: "agent-controller -> agent-acp-service",
    maxConfigurationBytes: 16777216,
    runTimeout: "30m",
  });
});

for (const [name, mutate] of [
  ["missing ACP service", (f) => delete f.services["agent-acp-service"]],
  [
    "missing publication URL",
    (f) =>
      delete f.services["agent-controller"].environment
        .ANTNEST_AGENT_ACP_SERVICE_URL,
  ],
  [
    "reverse Controller lookup",
    (f) => {
      f.services["agent-acp-service"].environment.ANTNEST_AGENT_CONTROLLER_URL =
        "http://agent-controller:8080";
    },
  ],
  [
    "retired Controller timeout",
    (f) => {
      f.services[
        "agent-acp-service"
      ].environment.ANTNEST_ACP_CONTROLLER_TIMEOUT = "5s";
    },
  ],
  [
    "retired admission TTL",
    (f) => {
      f.services[
        "agent-controller"
      ].environment.ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL = "30m";
    },
  ],
  [
    "different configuration limits",
    (f) => {
      f.services[
        "agent-acp-service"
      ].environment.ANTNEST_ACP_MAX_CONFIGURATION_BYTES = "1024";
    },
  ],
  [
    "implicit configuration limit",
    (f) =>
      delete f.services["agent-controller"].environment
        .ANTNEST_ACP_MAX_CONFIGURATION_BYTES,
  ],
  [
    "missing execution deadline",
    (f) =>
      delete f.services["agent-acp-service"].environment
        .ANTNEST_ACP_RUN_TIMEOUT,
  ],
  [
    "ACP waits for Controller",
    (f) => {
      f.services["agent-acp-service"].depends_on["agent-controller"] = {
        condition: "service_healthy",
      };
    },
  ],
  [
    "Controller waits for ACP",
    (f) => {
      f.services["agent-controller"].depends_on["agent-acp-service"] = {
        condition: "service_healthy",
      };
    },
  ],
  [
    "no shared network",
    (f) => {
      f.services["agent-acp-service"].networks = { isolated: {} };
    },
  ],
]) {
  test(`execution deployment rejects ${name}`, () => {
    const config = fixture();
    mutate(config);
    assert.throws(() => verifyExecutionDeployment(config));
  });
}

test("deployment diagnostics never echo environment secrets", () => {
  const config = fixture();
  const secret = "synthetic-secret-never-print";
  config.services[
    "agent-controller"
  ].environment.ANTNEST_AGENT_ACP_SERVICE_URL =
    `http://user:${secret}@agent-acp-service:8080`;
  assert.throws(
    () => verifyExecutionDeployment(config),
    (error) => !String(error).includes(secret),
  );
});

test("optional Console audit consumer must target the configured ACP origin", () => {
  const config = fixture();
  config.services["admin-console"] = { environment: {} };
  assert.throws(() => verifyExecutionDeployment(config));
  config.services["admin-console"].environment.ANTNEST_AGENT_ACP_SERVICE_URL =
    "http://agent-controller:8080";
  assert.throws(() => verifyExecutionDeployment(config));
  config.services["admin-console"].environment.ANTNEST_AGENT_ACP_SERVICE_URL =
    "http://agent-acp-service:8080";
  verifyExecutionDeployment(config);
});

test("snapshot byte limits reject non-decimal values accepted by JavaScript Number", () => {
  const config = fixture();
  for (const service of Object.values(config.services)) {
    service.environment.ANTNEST_ACP_MAX_CONFIGURATION_BYTES = "0x400";
  }
  assert.throws(() => verifyExecutionDeployment(config));
});

test("publication origin cannot rely on WHATWG path normalization", () => {
  const config = fixture();
  for (const value of [
    "http://agent-acp-service:8080/./",
    "http://agent-acp-service:8080/a/..",
    "http://agent-acp-service:8080/?",
    "http://agent-acp-service:8080/#",
  ]) {
    config.services[
      "agent-controller"
    ].environment.ANTNEST_AGENT_ACP_SERVICE_URL = value;
    assert.throws(() => verifyExecutionDeployment(config));
  }
});
