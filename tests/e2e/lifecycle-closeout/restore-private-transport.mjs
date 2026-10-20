import assert from "node:assert/strict";
import { lines } from "./docker.mjs";

const services = ["diagnostic-relay", "foundation-client-telemetry", "jaeger"];
function transportIdentity(receipt) {
  assert.equal(receipt.rows.length, services.length);
  const identity = services.map((name) => {
    const matches = receipt.rows.filter(
      (row) => row.Config.Labels["com.docker.compose.service"] === name,
    );
    assert.equal(matches.length, 1, "one Restore transport service required");
    const [row] = matches;
    assert.equal(
      row.Config.Labels["com.docker.compose.project"],
      receipt.project,
    );
    assert.equal(row.State.Running, true);
    if (name !== "jaeger") assert.equal(row.State.Health?.Status, "healthy");
    assert(typeof row.Id === "string" && row.Id.length > 0);
    assert.match(row.Image, /^sha256:[a-f0-9]{64}$/u);
    assert(Number.isFinite(Date.parse(row.State.StartedAt)));
    assert(Number.isSafeInteger(row.RestartCount) && row.RestartCount >= 0);
    const ports = Object.fromEntries(
      Object.entries(row.NetworkSettings.Ports).filter(
        ([, bindings]) => bindings?.length,
      ),
    );
    const expected =
      name === "diagnostic-relay"
        ? [5432, 16686, 58081, 58082]
        : name === "foundation-client-telemetry"
          ? [4318]
          : [];
    assert.deepEqual(
      Object.keys(ports).sort(),
      expected.map((p) => p + "/tcp").sort(),
    );
    const origins = {};
    for (const port of expected) {
      const bindings = ports[port + "/tcp"];
      assert.equal(bindings.length, 1);
      const [binding] = bindings;
      assert.equal(binding.HostIp, "127.0.0.1");
      assert.match(binding.HostPort, /^[1-9][0-9]*$/u);
      assert(Number(binding.HostPort) <= 65535);
      origins[port] = "http://127.0.0.1:" + binding.HostPort;
    }
    return {
      name,
      id: row.Id,
      image: row.Image,
      started: row.State.StartedAt,
      restarts: row.RestartCount,
      origins,
    };
  });
  assert.equal(new Set(identity.map((row) => row.id)).size, 3);
  assert.equal(receipt.jaeger, identity[0].origins[16686]);
  assert.deepEqual(receipt.privateAccess, {
    acp: identity[0].origins[58081],
    identity: identity[0].origins[58082],
    otlp: identity[1].origins[4318] + "/v1/traces",
    credentials: receipt.privateAccess.credentials,
  });
  assert(
    typeof receipt.privateAccess.credentials === "string" &&
      receipt.privateAccess.credentials.startsWith("/"),
  );
  return identity;
}

export async function readRestoreTransport(config, docker) {
  const ids = lines(await docker(config.compose(["ps", "-q", ...services])));
  assert.equal(ids.length, services.length);
  assert.equal(new Set(ids).size, services.length);
  const rows = JSON.parse(await docker(["inspect", ...ids]));
  assert.deepEqual(rows.map((r) => r.Id).sort(), [...ids].sort());
  const receipt = {
    project: config.project,
    privateAccess: structuredClone(config.privateAccess),
    jaeger: config.jaeger,
    rows,
  };
  transportIdentity(receipt);
  return receipt;
}

export function assertRestoreTransportContinuity(before, after) {
  assert.deepEqual(transportIdentity(after), transportIdentity(before));
  assert.equal(after.project, before.project);
  assert.equal(after.jaeger, before.jaeger);
  assert.deepEqual(after.privateAccess, before.privateAccess);
}
