import assert from "node:assert/strict";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";

test("Gateway Compose enables the bounded cache and keeps metrics opt-in", () => {
  const gateway = composeConfig().services["edge-gateway"];
  assert.equal(gateway.environment.ANTNEST_EDGE_RESOLVE_CACHE_TTL, "10s");
  assert.equal(gateway.environment.ANTNEST_EDGE_RESOLVE_CACHE_SIZE, "50000");
  assert.equal(gateway.environment.OTEL_METRICS_EXPORTER, "none");
  assert.equal(gateway.stop_grace_period, "40s");
});

test("Gateway Compose forwards cache bypass and a separate metrics receiver", () => {
  const selected = {
    ANTNEST_EDGE_RESOLVE_CACHE_TTL: "0s",
    ANTNEST_EDGE_RESOLVE_CACHE_SIZE: "7",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
      "http://metrics-receiver:4318/v1/metrics",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
    OTEL_METRIC_EXPORT_INTERVAL: "1000",
    OTEL_METRIC_EXPORT_TIMEOUT: "500",
  };
  const gateway = composeConfig(["compose.yaml"], selected).services[
    "edge-gateway"
  ];
  for (const [key, value] of Object.entries(selected)) {
    assert.equal(gateway.environment[key], value, key);
  }
});
