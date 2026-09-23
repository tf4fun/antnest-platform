import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function assertOwned(row, project, run) {
  assert.match(project, /^antnest-stage3-e2e-[0-9]+$/);
  assert(run);
  assert.equal(row.Config.Labels["com.docker.compose.project"], project);
  assert.equal(
    row.Config.Labels["com.docker.compose.service"],
    "agent-acp-service",
  );
  assert.equal(row.Config.Labels["io.antnest.e2e-run-id"], run);
  assert.equal(row.State.Running, true);
  assert.equal(row.State.Health.Status, "healthy");
  assert.equal(row.State.OOMKilled, false);
}
const same = (a, b) => {
  assert.equal(a.Id, b.Id);
  assert.equal(a.RestartCount, b.RestartCount);
  assert.deepEqual(a.Config.Labels, b.Config.Labels);
  assert.equal(b.State.OOMKilled, false);
};
export function assertStopped(before, after) {
  same(before, after);
  assert.equal(after.State.Running, false);
  assert.equal(after.State.ExitCode, 1);
  assert.equal(before.State.StartedAt, after.State.StartedAt);
}
export function assertRestarted(before, after) {
  same(before, after);
  assert.equal(after.State.Running, true);
  assert.equal(after.State.Health.Status, "healthy");
  assert.notEqual(before.State.StartedAt, after.State.StartedAt);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const read = async (path) => JSON.parse(await readFile(path, "utf8"))[0];
  const [mode, before, after] = process.argv.slice(2),
    a = await read(before);
  if (mode === "owned")
    assertOwned(
      a,
      process.env.COMPOSE_PROJECT_NAME,
      process.env.ANTNEST_E2E_RUN_ID,
    );
  else if (mode === "stopped") assertStopped(a, await read(after));
  else {
    assert.equal(mode, "restarted");
    assertRestarted(a, await read(after));
  }
}
