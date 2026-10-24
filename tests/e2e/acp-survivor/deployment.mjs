import assert from "node:assert/strict";

const initializerNames = new Set([
  "temporal-databases",
  "temporal-schema",
  "temporal-namespace",
  "skill-registry-database-init",
]);

export function partitionSurvivorDeployment(rows, project) {
  assert(Array.isArray(rows));
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const baseRows = [];
  const initializers = [];
  const seen = new Set();
  let peer;
  for (const row of rows) {
    const labels = row.Config?.Labels ?? {};
    const service = labels["com.docker.compose.service"];
    if (initializerNames.has(service)) {
      assert.equal(
        seen.has(service),
        false,
        "Duplicate deployment initializer",
      );
      seen.add(service);
      assert.equal(labels["com.docker.compose.project"], project);
      assert.equal(row.State?.Status, "exited", `${service} did not complete`);
      assert.equal(row.State?.Running, false, `${service} is still running`);
      assert.equal(row.State?.ExitCode, 0, `${service} initialization failed`);
      assert.equal(row.State?.OOMKilled, false, `${service} was OOM-killed`);
      assert(row.State?.Error === "", `${service} has an engine error`);
      const bindings = Object.values(
        row.HostConfig?.PortBindings ?? {},
      ).flatMap((value) => value ?? []);
      assert.equal(bindings.length, 0, `${service} exposes a host port`);
      initializers.push(row);
    } else if (service === "agent-acp-peer-b") {
      assert(peer === undefined, "Duplicate ACP peer replica");
      assert.equal(labels["com.docker.compose.project"], project);
      peer = row;
    } else {
      // Unknown and stopped resident services must reach the original strict
      // service-set, image, health and port checks without being filtered out.
      baseRows.push(row);
    }
  }
  assert.equal(
    seen.size,
    initializerNames.size,
    "Missing deployment initializer",
  );
  assert(peer !== undefined, "Missing ACP peer replica");
  return { baseRows, peer, initializers };
}
