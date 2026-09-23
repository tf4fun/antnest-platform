import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
export function inspectProxy(rows, project) {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.Config.Labels["com.docker.compose.project"], project);
  assert.equal(
    row.Config.Labels["com.docker.compose.service"],
    "rpc-loss-proxy",
  );
  assert.equal(row.State.Running, true);
  assert.equal(row.State.Health.Status, "healthy");
  assert.deepEqual(Object.values(row.HostConfig.PortBindings ?? {}).flat(), []);
}
export function assertSameProcess(before, after) {
  for (const row of [before, after]) {
    assert.equal(row.State.Running, true);
    assert.equal(row.State.Health.Status, "healthy");
  }
  assert.equal(after.Id, before.Id);
  assert.equal(after.RestartCount, before.RestartCount);
  assert.equal(after.State.StartedAt, before.State.StartedAt);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const before = JSON.parse(await readFile(process.argv[2], "utf8")),
    project = process.argv[3];
  if (process.argv[4]) {
    const after = JSON.parse(await readFile(process.argv[4], "utf8"));
    const acp = (rows) =>
      rows.find(
        (r) =>
          r.Config.Labels["com.docker.compose.service"] === "agent-acp-service",
      );
    assertSameProcess(acp(before), acp(after));
    console.log(
      JSON.stringify({
        status: "acp_process_passed",
        same_container: true,
        same_start: true,
        restarts_unchanged: true,
      }),
    );
  } else {
    const proxy = (r) =>
      r.Config.Labels["com.docker.compose.service"] === "rpc-loss-proxy";
    inspectProxy(before.filter(proxy), project);
    console.log(
      JSON.stringify({
        ...inspectDeployment(
          before.filter((r) => !proxy(r)),
          project,
        ),
        services: before.length,
        private_fault_proxy: true,
      }),
    );
  }
}
