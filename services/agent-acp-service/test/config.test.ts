import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("loadConfig", () => {
  it("validates required values and applies bounded defaults", () => {
    const config = loadConfig(requiredEnvironment());

    expect(config.listen).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(config.databaseUrl).toBe("postgres://agent:secret@postgres/agent_acp");
    expect(config.agentControllerUrl.href).toBe("http://agent-controller:8080/");
    expect(config.clientMcpKey).toEqual(Buffer.alloc(32, 7));
    expect(config.clientMcpBlockedCidrs).toEqual([]);
    expect(config.controllerTimeoutMs).toBe(5_000);
    expect(config.maxWebSocketPayloadBytes).toBe(16 * 1024 * 1024);
    expect(config.shutdownTimeoutMs).toBe(15_000);
    expect(config.telemetry).toEqual({
      disabled: false,
      metricsEnabled: false,
      serviceName: "agent-acp-service",
      tracesEnabled: false,
    });
  });

  it("parses explicit IPv6, duration, CIDR, and telemetry values", () => {
    const config = loadConfig({
      ...requiredEnvironment(),
      ANTNEST_ACP_LISTEN: "[::1]:18080",
      ANTNEST_ACP_CLIENT_MCP_BLOCKED_CIDRS: "203.0.113.0/24, 2001:db8::/32",
      ANTNEST_ACP_CONTROLLER_TIMEOUT: "750ms",
      ANTNEST_ACP_MAX_PROMPT_BYTES: "1048576",
      ANTNEST_ACP_SHUTDOWN_TIMEOUT: "2m",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
      OTEL_SERVICE_NAME: "antnest-acp-test",
      OTEL_SDK_DISABLED: "true",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "none",
    });

    expect(config.listen).toEqual({ host: "::1", port: 18080 });
    expect(config.clientMcpBlockedCidrs).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
    expect(config.controllerTimeoutMs).toBe(750);
    expect(config.maxWebSocketPayloadBytes).toBe(1_048_576);
    expect(config.shutdownTimeoutMs).toBe(120_000);
    expect(config.telemetry).toEqual({
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
    ["invalid controller scheme", { ANTNEST_AGENT_CONTROLLER_URL: "file:///tmp/controller" }],
    ["invalid database scheme", { ANTNEST_ACP_DATABASE_URL: "sqlite:///tmp/acp.db" }],
    ["invalid listen port", { ANTNEST_ACP_LISTEN: ":70000" }],
    ["unbracketed IPv6", { ANTNEST_ACP_LISTEN: "::1:8080" }],
    ["zero timeout", { ANTNEST_ACP_CONTROLLER_TIMEOUT: "0s" }],
    ["oversized payload", { ANTNEST_ACP_MAX_PROMPT_BYTES: String(65 * 1024 * 1024) }],
    ["invalid OTEL disable flag", { OTEL_SDK_DISABLED: "yes" }],
    ["invalid OTEL traces exporter", { OTEL_TRACES_EXPORTER: "console" }],
    ["invalid OTEL metrics exporter", { OTEL_METRICS_EXPORTER: "prometheus" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => loadConfig({ ...requiredEnvironment(), ...overrides })).toThrow();
  });
});

function requiredEnvironment(): NodeJS.ProcessEnv {
  return {
    ANTNEST_ACP_DATABASE_URL: "postgres://agent:secret@postgres/agent_acp",
    ANTNEST_AGENT_CONTROLLER_URL: "http://agent-controller:8080",
    ANTNEST_ACP_CLIENT_MCP_KEY: KEY,
  };
}
