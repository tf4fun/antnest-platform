import assert from "node:assert/strict";

export function configureFoundationPrivate(config) {
  const compose = config.compose;
  config.compose = (args) =>
    compose([
      "-f",
      "tests/e2e/lifecycle-closeout/foundation-private.compose.yaml",
      ...args,
    ]);
}

export function inspectFoundationPrivateDeployment(rows, config) {
  const select = (name) => {
    const matches = rows.filter(
      (row) => row.Config.Labels["com.docker.compose.service"] === name,
    );
    assert.equal(matches.length, 1, "one Foundation " + name + " required");
    const [row] = matches;
    assert.equal(
      row.Config.Labels["com.docker.compose.project"],
      config.project,
    );
    assert.equal(row.State.Running, true);
    assert.equal(row.State.Health?.Status, "healthy");
    return row;
  };
  const relay = select("diagnostic-relay"),
    exporter = select("foundation-client-telemetry");
  const bindings = (row, expected) => {
    assert.deepEqual(
      Object.entries(row.NetworkSettings.Ports)
        .filter(([, value]) => value?.length)
        .map(([key]) => key)
        .sort(),
      expected.map((port) => `${port}/tcp`).sort(),
    );
    const origins = {};
    for (const port of expected) {
      const values = row.NetworkSettings.Ports[`${port}/tcp`];
      assert.equal(values.length, 1);
      assert.equal(values[0].HostIp, "127.0.0.1");
      assert.match(values[0].HostPort, /^[1-9][0-9]*$/u);
      assert(Number(values[0].HostPort) <= 65535);
      origins[port] = `http://127.0.0.1:${values[0].HostPort}`;
    }
    return origins;
  };
  const receiver = bindings(relay, [5432, 16686, 58081, 58082]);
  const telemetry = bindings(exporter, [4318]);
  assert.equal(exporter.Config.Image, "node:24.21.0-bookworm-slim");
  assert.equal(exporter.Config.User, "65532:65532");
  assert.deepEqual(exporter.Config.Cmd, [
    "node",
    "/opt/antnest/scripts/deployment/runtime-telemetry-ingress.mjs",
  ]);
  assert.equal(exporter.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(exporter.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(exporter.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.deepEqual(
    exporter.Mounts.map(({ Type, Destination, RW }) => [
      Type,
      Destination,
      RW,
    ]).sort(),
    [
      [
        "bind",
        "/opt/antnest/contracts/platform/development-network-contract.json",
        false,
      ],
      ["bind", "/opt/antnest/scripts/deployment", false],
    ],
  );
  const environment = Object.fromEntries(
    exporter.Config.Env.map((value) => {
      const split = value.indexOf("=");
      return [value.slice(0, split), value.slice(split + 1)];
    }),
  );
  assert.equal(
    environment.ANTNEST_SERVICE_NETWORK_PREFIX,
    config.env.ANTNEST_SERVICE_NETWORK_PREFIX,
  );
  assert.equal(
    environment.ANTNEST_RUNTIME_OTLP_INGRESS_IPV4,
    config.env.ANTNEST_SERVICE_NETWORK_PREFIX + ".147",
  );
  const networks = exporter.NetworkSettings.Networks;
  assert.deepEqual(
    Object.keys(networks).sort(),
    [
      config.project + "_diagnostic-ingress",
      config.project + "_observability",
    ].sort(),
  );
  assert.equal(
    networks[config.project + "_diagnostic-ingress"].IPAddress,
    config.env.ANTNEST_SERVICE_NETWORK_PREFIX + ".147",
  );
  assert.equal(
    networks[config.project + "_observability"].IPAddress,
    config.env.ANTNEST_SERVICE_NETWORK_PREFIX + ".126",
  );
  assert(
    typeof config.credentials === "string" &&
      config.credentials.startsWith("/"),
  );
  config.privateAccess = {
    acp: receiver[58081],
    identity: receiver[58082],
    otlp: telemetry[4318] + "/v1/traces",
    credentials: config.credentials,
  };
  // Validate the complete new boundary first, then apply the unchanged base
  // deployment checks to its original services and publications. Raw inspect
  // evidence remains intact and other profiles never use this projection.
  return rows
    .filter((row) => row !== exporter)
    .map((row) => {
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
