import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("loadConfig", () => {
  it("validates required values and applies bounded defaults", () => {
    const config = loadConfig(requiredEnvironment());

    expect(config.listen).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(config.databaseUrl).toBe("postgres://agent:secret@postgres/agent_acp");
    expect(config.databaseTimeoutMs).toBe(10_000);
    expect(config.stateDeliveryTimeoutMs).toBe(10_000);
    expect(config.clientMcpKey).toEqual(Buffer.alloc(32, 7));
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

  it("parses explicit IPv6, duration and telemetry values", () => {
    const config = loadConfig({
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
  ])("rejects %s", (_name, overrides) => {
    expect(() => loadConfig({ ...requiredEnvironment(), ...overrides })).toThrow();
  });
});

function requiredEnvironment(): NodeJS.ProcessEnv {
  return {
    ANTNEST_ACP_DATABASE_URL: "postgres://agent:secret@postgres/agent_acp",
    ANTNEST_ACP_CLIENT_MCP_KEY: KEY,
  };
}
