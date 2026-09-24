import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServiceConfig } from "../src/service-config.ts";

test("Bridge service requires an internal ACP base and a valid listen port", () => {
  assert.deepEqual(
    parseServiceConfig({
      ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
      ANTNEST_AGENT_UI_BRIDGE_PORT: "8080",
    }),
    {
      acpBaseUrl: new URL("http://agent-acp-service:8080/"),
      controllerBaseUrl: undefined,
      host: "0.0.0.0",
      port: 8080,
      maxSessionHistoryBytes: 64 * 1024 * 1024,
      maxCachedHistoryBytes: 256 * 1024 * 1024,
      maxGlobalHistoryBytes: 512 * 1024 * 1024,
      maxOwners: 16,
      maxAcpPromptBytes: 16 * 1024 * 1024,
      idleMs: 300_000,
      sweepIntervalMs: 30_000,
      telemetry: { disabled: false, endpoint: undefined, serviceName: "agent-ui" },
    },
  );
  assert.throws(() => parseServiceConfig({}), /ACP service URL/i);
  assert.throws(
    () =>
      parseServiceConfig({
        ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
        ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS: "0",
      }),
    /owner capacity/i,
  );
  assert.throws(
    () =>
      parseServiceConfig({
        ANTNEST_AGENT_ACP_SERVICE_URL:
          "http://user:pass@agent-acp-service:8080",
      }),
    /ACP service URL/i,
  );
  assert.throws(
    () =>
      parseServiceConfig({
        ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
        ANTNEST_AGENT_UI_BRIDGE_PORT: "0",
      }),
    /listen port/i,
  );
  assert.throws(
    () =>
      parseServiceConfig({
        ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
        ANTNEST_AGENT_UI_BRIDGE_SESSION_HISTORY_BYTES: "1048576",
        ANTNEST_AGENT_UI_BRIDGE_CACHE_BYTES: "1048576",
      }),
    /cache budget/i,
  );
  assert.equal(parseServiceConfig({
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
    ANTNEST_AGENT_CONTROLLER_URL: "http://agent-controller:8080",
  }).controllerBaseUrl?.href, "http://agent-controller:8080/");
  assert.throws(() => parseServiceConfig({
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
    ANTNEST_AGENT_CONTROLLER_URL: "http://user:pass@agent-controller:8080",
  }), /Controller service URL/i);
  assert.throws(() => parseServiceConfig({
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
    ANTNEST_AGENT_UI_BRIDGE_TOTAL_HISTORY_BYTES: "67108864",
  }), /total history budget/i);
  assert.deepEqual((({ idleMs, sweepIntervalMs }) => ({ idleMs, sweepIntervalMs }))(
    parseServiceConfig({
      ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
      ANTNEST_AGENT_UI_BRIDGE_IDLE_MS: "250",
      ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS: "50",
    })), { idleMs: 250, sweepIntervalMs: 50 });
  for (const value of ["-1", "1.5", "infinite"])
    assert.throws(() => parseServiceConfig({
      ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
      ANTNEST_AGENT_UI_BRIDGE_IDLE_MS: value,
    }), /idle lifetime/i);
  assert.throws(() => parseServiceConfig({
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
    ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS: "0",
  }), /sweep interval/i);
  assert.equal(parseServiceConfig({
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
    ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES: "8388608",
  }).maxAcpPromptBytes, 8 * 1024 * 1024);
  for (const value of ["0", "1023", "67108865", "16m"])
    assert.throws(() => parseServiceConfig({
      ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
      ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES: value,
    }), /ACP prompt bound/i);
  assert.deepEqual(parseServiceConfig({
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
    OTEL_SDK_DISABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/otlp",
    OTEL_SERVICE_NAME: "agent-ui-custom",
  }).telemetry, {
    disabled: true, endpoint: new URL("http://collector:4318/otlp"),
    serviceName: "agent-ui-custom",
  });
  assert.throws(() => parseServiceConfig({
    ANTNEST_AGENT_ACP_SERVICE_URL: "http://agent-acp-service:8080",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:secret@collector:4318",
  }), /OTLP endpoint/i);
});
