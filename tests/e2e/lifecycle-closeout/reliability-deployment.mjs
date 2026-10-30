import assert from "node:assert/strict";

const PROXY_SERVICE = "reliability-proxy";
const PROXY_NETWORK = "controller-runtime";

// inspectReliabilityDeployment verifies exactly one owned reliability-proxy
// fixture with the real Docker inspect shape before the caller applies the
// existing base deployment proof to the remaining rows. It never mutates rows.
export function inspectReliabilityDeployment(rows, config) {
  assert(Array.isArray(rows), "deployment rows must be an array");
  const serviceOf = (row) => row.Config?.Labels?.["com.docker.compose.service"];
  const projectOf = (row) => row.Config?.Labels?.["com.docker.compose.project"];
  const proxies = rows.filter((row) => serviceOf(row) === PROXY_SERVICE);
  assert.equal(
    proxies.length,
    1,
    "exactly one reliability-proxy fixture is required",
  );
  const proxy = proxies[0];
  assert.equal(
    projectOf(proxy),
    config.project,
    "reliability-proxy must belong to the owned deployment project",
  );
  assert.equal(proxy.State?.Running, true, "reliability-proxy must be running");
  assert.equal(
    proxy.State?.Health?.Status,
    "healthy",
    "reliability-proxy must report a healthy healthcheck",
  );
  assert.deepEqual(
    proxy.Config?.Cmd,
    ["node", "/fixtures/reliability-proxy.mjs"],
    "reliability-proxy must run the Node fixture command",
  );
  for (const bindings of Object.values(proxy.HostConfig?.PortBindings ?? {})) {
    assert(
      !bindings || bindings.length === 0,
      "reliability-proxy must not publish a host port",
    );
  }
  for (const bindings of Object.values(proxy.NetworkSettings?.Ports ?? {})) {
    assert(
      !bindings || bindings.length === 0,
      "reliability-proxy must not bind a host port",
    );
  }
  const mounts = proxy.Mounts ?? [];
  assert.equal(mounts.length, 1, "exactly one fixture mount is required");
  assert.equal(mounts[0].Type, "bind", "fixture mount must be a bind");
  assert.equal(mounts[0].Destination, "/fixtures", "fixture mount destination");
  assert.equal(mounts[0].RW, false, "fixture mount must be read-only");
  assert(
    typeof mounts[0].Source === "string" &&
      mounts[0].Source.endsWith("/tests/e2e/lifecycle-closeout"),
    "fixture mount must source the reliability test directory",
  );
  const networks = proxy.NetworkSettings?.Networks ?? {};
  const runtime = networks[`${config.project}_${PROXY_NETWORK}`];
  assert(
    runtime,
    "reliability-proxy must join the owned controller-runtime network",
  );
  assert.equal(
    runtime.IPAddress,
    `${config.env.ANTNEST_SERVICE_NETWORK_PREFIX}.60`,
    "reliability-proxy must sit at the fixture address",
  );
  return rows.filter((row) => row !== proxy);
}
