import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const MAINTENANCE_KIDS = JSON.parse(
  readFileSync(
    new URL("../../../contracts/runtime/maintenance-kid-fixtures.json", import.meta.url),
    "utf8",
  ),
) as { valid: string[]; invalid: string[] };
const SIGNING_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({
    type: "pkcs8",
    format: "der",
  })
  .toString("base64");

describe("loadConfig", () => {
  it("carries the validated service mode and exact HTTP opt-in to Runtime transport without credentials", async () => {
    const config = loadConfig({ ...testSecurityEnvironment(), ...requiredEnvironment() });
    try {
      expect(config.authentication.workload.runtimeTransport()).toEqual({
        authMode: "token",
        allowInsecureTransport: "true",
      });
    } finally {
      await config.authentication.workload.close();
    }
  });
  it("defaults private Provider access off and accepts only exact operator values", () => {
    const env = { ...testSecurityEnvironment(), ...requiredEnvironment() };
    expect(loadConfig(env).providerAllowPrivateEndpoints).toBe(false);
    expect(
      loadConfig({ ...env, ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "false" })
        .providerAllowPrivateEndpoints,
    ).toBe(false);
    expect(
      loadConfig({ ...env, ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "true" })
        .providerAllowPrivateEndpoints,
    ).toBe(true);
  });
  it.each(["", " true", "true ", "TRUE", "False", "1"])(
    "rejects non-exact private Provider opt-in %j at startup",
    (value) => {
      expect(() =>
        loadConfig({
          ...testSecurityEnvironment(),
          ...requiredEnvironment(),
          ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: value,
        }),
      ).toThrow();
    },
  );
  it.each(MAINTENANCE_KIDS.valid)("accepts shared maintenance kid %j unchanged", (kid) => {
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ...{
        ...requiredEnvironment(),
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: kid,
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: SIGNING_KEY,
      },
    });
    expect(config.skillMaintenanceSigning?.kid).toBe(kid);
  });

  it.each(MAINTENANCE_KIDS.invalid)("rejects shared maintenance kid %j", (kid) => {
    expect(() =>
      loadConfig({
        ...testSecurityEnvironment(),
        ...{
          ...requiredEnvironment(),
          ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: kid,
          ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: SIGNING_KEY,
        },
      }),
    ).toThrow();
  });

  it("enables discovery with authenticated dependencies and rejects legacy tokens", () => {
    const env = {
      ...requiredEnvironment(),
      ANTNEST_ACP_SKILL_REGISTRY_URL: "http://skill-registry:8080",
      ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "source-key",
      ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: SIGNING_KEY,
    };
    expect(loadConfig({ ...testSecurityEnvironment(), ...env }).skillDiscovery).toEqual({
      registryUrl: "http://skill-registry:8080/",
    });
    for (const patch of [
      { ANTNEST_ACP_SKILL_SOURCE_TOKEN: "legacy-token" },
      { ANTNEST_ACP_SKILL_REGISTRY_TOKEN: "short" },
      { ANTNEST_ACP_SKILL_REGISTRY_URL: "http://identity.invalid/" },
      { ANTNEST_ACP_SKILL_REGISTRY_URL: "http://registry/other/" },
      {
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: undefined,
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: undefined,
      },
    ])
      expect(() => loadConfig({ ...testSecurityEnvironment(), ...{ ...env, ...patch } })).toThrow();
    expect(
      loadConfig({ ...testSecurityEnvironment(), ...requiredEnvironment() }).skillDiscovery,
    ).toBeUndefined();
  });
  it("validates required values and applies bounded defaults", () => {
    const config = loadConfig({ ...testSecurityEnvironment(), ...requiredEnvironment() });

    expect(config.listen).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(config.controlListen).toEqual({ host: "0.0.0.0", port: 8081 });
    expect(config.databaseUrl).toBe("postgres://agent:secret@postgres/agent_acp");
    expect(config.databaseTimeoutMs).toBe(10_000);
    expect(config.stateDeliveryTimeoutMs).toBe(10_000);
    expect(config.clientMcpKey).toEqual(Buffer.from("0123456789abcdef0123456789abcdef"));
    expect(config.skillMaintenanceSigning).toBeUndefined();
    expect(config.skillLearningControllerUrl).toBeUndefined();
    expect(config.skillLearningDebugAgentId).toBeUndefined();
    expect(config.allowDevelopmentSettings).toBe(false);
    expect(config.runTimeoutMs).toBe(1_800_000);
    expect(config.maxWebSocketPayloadBytes).toBe(16 * 1024 * 1024);
    expect(config.maxConfigurationBytes).toBe(16 * 1024 * 1024);
    expect(config.shutdownTimeoutMs).toBe(15_000);
    expect(config.telemetry).toEqual({
      captureRpcContent: false,
      disabled: false,
      metricsEnabled: false,
      serviceName: "agent-acp-service",
      tracesEnabled: false,
    });
  });

  it("loads an Ed25519 maintenance signer only with a complete identity", () => {
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ...{
        ...requiredEnvironment(),
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "key-next",
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: SIGNING_KEY,
      },
    });
    expect(config.skillMaintenanceSigning?.kid).toBe("key-next");
    expect(config.skillMaintenanceSigning?.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(config.skillMaintenanceSigning?.privateKey.type).toBe("private");
  });

  it("loads a normalized Controller endpoint for Skill learning policy reads", () => {
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ...{
        ...requiredEnvironment(),
        ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL: "http://agent-controller:8080",
      },
    });
    expect(config.skillLearningControllerUrl).toBe("http://agent-controller:8080/");
  });

  it("scopes development debug learning to one explicitly configured Agent", () => {
    expect(
      loadConfig({
        ...testSecurityEnvironment(),
        ...{
          ...requiredEnvironment(),
          ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: "true",
          ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: " agent-debug ",
        },
      }).skillLearningDebugAgentId,
    ).toBe("agent-debug");
    expect(
      loadConfig({
        ...testSecurityEnvironment(),
        ...{
          ...requiredEnvironment(),
          ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "",
        },
      }).skillLearningDebugAgentId,
    ).toBeUndefined();
    expect(() =>
      loadConfig({
        ...testSecurityEnvironment(),
        ...{
          ...requiredEnvironment(),
          ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: "true",
          ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "agent/other",
        },
      }),
    ).toThrow();
  });

  it.each([undefined, "false"])(
    "rejects debug learning when the development gate is %j",
    (gate) => {
      expect(() =>
        loadConfig({
          ...testSecurityEnvironment(),
          ...{
            ...requiredEnvironment(),
            ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: gate,
            ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "agent-debug",
          },
        }),
      ).toThrow(
        new ConfigError(
          "ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID requires ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS=true",
        ),
      );
    },
  );

  it.each(["true", "false"])("accepts the exact development gate %j", (gate) => {
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ...{
        ...requiredEnvironment(),
        ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: gate,
      },
    });
    expect(config.allowDevelopmentSettings).toBe(gate === "true");
    expect(config.skillLearningDebugAgentId).toBeUndefined();
  });

  it.each(["", " ", "TRUE", "False", " true ", "false ", "yes", "1", "0"])(
    "rejects malformed development gate %j even without a debug Agent",
    (gate) => {
      expect(() =>
        loadConfig({
          ...testSecurityEnvironment(),
          ...{
            ...requiredEnvironment(),
            ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: gate,
          },
        }),
      ).toThrow(new ConfigError("ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS must be true or false"));
    },
  );

  it("parses explicit IPv6, duration and telemetry values", () => {
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ...{
        ...requiredEnvironment(),
        ANTNEST_ACP_LISTEN: "[::1]:18080",
        ANTNEST_ACP_RUN_TIMEOUT: "750ms",
        ANTNEST_ACP_DATABASE_TIMEOUT: "3s",
        ANTNEST_ACP_STATE_DELIVERY_TIMEOUT: "250ms",
        ANTNEST_ACP_MAX_PROMPT_BYTES: "1048576",
        ANTNEST_ACP_MAX_CONFIGURATION_BYTES: "2097152",
        ANTNEST_ACP_SHUTDOWN_TIMEOUT: "2m",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
        OTEL_SERVICE_NAME: "antnest-acp-test",
        OTEL_SDK_DISABLED: "true",
        ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "true",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "none",
      },
    });

    expect(config.listen).toEqual({ host: "::1", port: 18080 });
    expect(config.runTimeoutMs).toBe(750);
    expect(config.databaseTimeoutMs).toBe(3000);
    expect(config.stateDeliveryTimeoutMs).toBe(250);
    expect(config.maxWebSocketPayloadBytes).toBe(1_048_576);
    expect(config.maxConfigurationBytes).toBe(2_097_152);
    expect(config.shutdownTimeoutMs).toBe(120_000);
    expect(config.telemetry).toEqual({
      captureRpcContent: true,
      disabled: true,
      endpoint: new URL("http://otel:4318/"),
      metricsEnabled: false,
      serviceName: "antnest-acp-test",
      tracesEnabled: true,
    });
  });

  it.each([
    ["missing database", { ANTNEST_ACP_DATABASE_URL: undefined }],
    ["short encryption key", { ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.alloc(31).toString("base64") }],
    ["invalid database scheme", { ANTNEST_ACP_DATABASE_URL: "sqlite:///tmp/acp.db" }],
    [
      "invalid Skill learning Controller URL",
      { ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL: "ftp://agent-controller" },
    ],
    [
      "Controller URL credentials",
      { ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL: "http://user:secret@agent-controller" },
    ],
    [
      "Controller URL query",
      { ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL: "http://agent-controller:8080/?x=1" },
    ],
    ["invalid listen port", { ANTNEST_ACP_LISTEN: ":70000" }],
    ["unbracketed IPv6", { ANTNEST_ACP_LISTEN: "::1:8080" }],
    ["zero Run timeout", { ANTNEST_ACP_RUN_TIMEOUT: "0s" }],
    ["zero database timeout", { ANTNEST_ACP_DATABASE_TIMEOUT: "0s" }],
    ["zero state delivery timeout", { ANTNEST_ACP_STATE_DELIVERY_TIMEOUT: "0s" }],
    ["invalid state delivery timeout", { ANTNEST_ACP_STATE_DELIVERY_TIMEOUT: "forever" }],
    ["excessive database timeout", { ANTNEST_ACP_DATABASE_TIMEOUT: "61m" }],
    ["invalid database timeout", { ANTNEST_ACP_DATABASE_TIMEOUT: "forever" }],
    ["excessive Run timeout", { ANTNEST_ACP_RUN_TIMEOUT: "61m" }],
    ["oversized payload", { ANTNEST_ACP_MAX_PROMPT_BYTES: String(65 * 1024 * 1024) }],
    ["oversized configuration", { ANTNEST_ACP_MAX_CONFIGURATION_BYTES: String(65 * 1024 * 1024) }],
    ["zero configuration bound", { ANTNEST_ACP_MAX_CONFIGURATION_BYTES: "0" }],
    ["invalid OTEL disable flag", { OTEL_SDK_DISABLED: "yes" }],
    ["invalid RPC content switch", { ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "raw" }],
    ["invalid OTEL traces exporter", { OTEL_TRACES_EXPORTER: "console" }],
    ["invalid OTEL metrics exporter", { OTEL_METRICS_EXPORTER: "prometheus" }],
    ["maintenance kid without private key", { ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "key-1" }],
    [
      "maintenance private key without kid",
      { ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: SIGNING_KEY },
    ],
    [
      "invalid maintenance kid",
      {
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "bad/key",
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: SIGNING_KEY,
      },
    ],
    [
      "invalid maintenance base64",
      {
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "key-1",
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: "not-base64",
      },
    ],
    [
      "non-Ed25519 maintenance key",
      {
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "key-1",
        ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: generateKeyPairSync("rsa", {
          modulusLength: 2048,
        })
          .privateKey.export({ type: "pkcs8", format: "der" })
          .toString("base64"),
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(() =>
      loadConfig({ ...testSecurityEnvironment(), ...{ ...requiredEnvironment(), ...overrides } }),
    ).toThrow();
  });
});

function requiredEnvironment(): NodeJS.ProcessEnv {
  return {
    ANTNEST_ACP_DATABASE_URL: "postgres://agent:secret@postgres/agent_acp",
    ANTNEST_ACP_CLIENT_MCP_KEY: KEY,
  };
}
