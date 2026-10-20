import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

export function configureHealthPrivate(config) {
  const compose = config.compose;
  config.compose = (args) =>
    compose([
      "-f",
      "tests/e2e/lifecycle-closeout/health-private.compose.yaml",
      ...args,
    ]);
}

export function inspectHealthPrivateDeployment(rows, config) {
  const matches = rows.filter(
    (row) =>
      row.Config.Labels["com.docker.compose.service"] === "diagnostic-relay",
  );
  assert.equal(matches.length, 1, "one Health diagnostic relay required");
  const [relay] = matches;
  assert.equal(
    relay.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(relay.State.Running, true);
  assert.equal(relay.State.Health?.Status, "healthy");
  const expected = ["5432/tcp", "16686/tcp", "58081/tcp", "58082/tcp"].sort();
  for (const [ports, observed] of [
    [relay.HostConfig.PortBindings, false],
    [relay.NetworkSettings.Ports, true],
  ]) {
    assert.deepEqual(
      Object.entries(ports)
        .filter(([, values]) => values?.length)
        .map(([port]) => port)
        .sort(),
      expected,
    );
    for (const port of expected) {
      const values = ports[port];
      assert.equal(values.length, 1);
      assert.equal(values[0].HostIp, "127.0.0.1");
      assert.match(
        values[0].HostPort,
        observed ? /^[1-9][0-9]*$/u : /^(?:0|[1-9][0-9]*)$/u,
      );
      assert(Number(values[0].HostPort) <= 65535);
    }
  }
  const published = expected.map(
    (port) => relay.NetworkSettings.Ports[port][0].HostPort,
  );
  assert.equal(
    new Set(published).size,
    expected.length,
    "Health relay ports must be distinct",
  );
  assert(
    typeof config.credentials === "string" && isAbsolute(config.credentials),
  );
  const origin = (port) =>
    "http://127.0.0.1:" +
    relay.NetworkSettings.Ports[port + "/tcp"][0].HostPort;
  config.healthPrivateAccess = {
    acp: origin(58081),
    identity: origin(58082),
    credentials: config.credentials,
  };
  // Preserve raw inspect evidence, then run the original fifteen-service and
  // candidate-image checks on the unchanged base publications.
  return rows.map((row) => {
    if (row !== relay) return row;
    const base = structuredClone(row);
    for (const ports of [
      base.HostConfig.PortBindings,
      base.NetworkSettings.Ports,
    ]) {
      delete ports["58081/tcp"];
      delete ports["58082/tcp"];
    }
    return base;
  });
}
