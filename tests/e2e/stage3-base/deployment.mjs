import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function inspectDeployment(rows, project) {
  const required = [
    "postgres",
    "jaeger",
    "edge-gateway",
    "temporal",
    "runtime-controller",
    "agent-acp-service",
    "identity-service",
    "agent-controller",
    "admin-console",
    "agent-ui",
    "runtime-egress",
  ];
  const names = rows.map(
    (row) => row.Config.Labels["com.docker.compose.service"],
  );
  assert.deepEqual(new Set(names), new Set(required));
  assert.equal(names.length, required.length);
  for (const row of rows) {
    const name = row.Config.Labels["com.docker.compose.service"];
    assert.equal(row.Config.Labels["com.docker.compose.project"], project);
    assert.equal(row.State.Running, true);
    if (name !== "jaeger") assert.equal(row.State.Health?.Status, "healthy");
    const bindings = Object.values(row.HostConfig.PortBindings ?? {}).flat();
    assert.equal(
      bindings.length,
      ["postgres", "jaeger", "edge-gateway"].includes(name) ? 1 : 0,
      `${name}: unexpected host ports`,
    );
    for (const binding of bindings) assert.equal(binding.HostIp, "127.0.0.1");
  }
  return {
    status: "deployment_passed",
    services: rows.length,
    gateway_only_application_ingress: true,
    loopback_diagnostics: true,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify(
      inspectDeployment(
        JSON.parse(await readFile(process.argv[2], "utf8")),
        process.argv[3],
      ),
    ),
  );
