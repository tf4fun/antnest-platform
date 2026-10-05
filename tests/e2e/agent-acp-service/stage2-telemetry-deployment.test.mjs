import assert from "node:assert/strict";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";

test("Stage2 client spans enter Jaeger through a bounded loopback ingress, retaining isolated collector networking", () => {
  const config = composeConfig(
    ["compose.yaml", "compose.debug.yaml", "tests/e2e/stage2.compose.yaml"],
    {
      ANTNEST_STAGE2_MODEL_HOST_PORT: "42010",
      ANTNEST_STAGE2_OTLP_HOST_PORT: "42011",
    },
  );
  assert.deepEqual(config.services.jaeger.ports ?? [], []);
  const ingress = config.services["stage2-client-telemetry"];
  assert(ingress, "test client telemetry ingress missing");
  assert.deepEqual(
    ingress.ports.map(({ host_ip, target, published }) => ({
      host_ip,
      target,
      published,
    })),
    [{ host_ip: "127.0.0.1", target: 4318, published: "42011" }],
  );
  assert.deepEqual(Object.keys(ingress.networks).sort(), [
    "diagnostic-ingress",
    "observability",
  ]);
  assert.equal(ingress.networks["diagnostic-ingress"].gw_priority, 1);
  assert.equal(
    ingress.environment.ANTNEST_RUNTIME_OTLP_INGRESS_IPV4,
    ingress.networks["diagnostic-ingress"].ipv4_address,
  );
  assert.equal(ingress.read_only, true);
  for (const [name, service] of Object.entries(config.services)) {
    if (name === "stage2-client-telemetry") continue;
    for (const [network, binding] of Object.entries(ingress.networks))
      assert.notEqual(
        binding.ipv4_address,
        service.networks?.[network]?.ipv4_address,
        `${name} address conflict`,
      );
  }
  assert(ingress.command[1].endsWith("/runtime-telemetry-ingress.mjs"));
  assert.equal(
    config.networks.observability.driver_opts[
      "com.docker.network.bridge.gateway_mode_ipv4"
    ],
    "isolated",
  );
});
