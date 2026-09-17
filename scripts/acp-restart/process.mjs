import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function assertKilled(before, after) {
  assert.equal(after.Id, before.Id);
  assert.equal(after.RestartCount, before.RestartCount);
  assert.deepEqual(after.Config.Labels, before.Config.Labels);
  assert.equal(after.State.Running, false);
  assert.equal(after.State.OOMKilled, false);
  assert.equal(after.State.ExitCode, 137);
  assert.equal(after.State.StartedAt, before.State.StartedAt);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const read = async (path) => JSON.parse(await readFile(path, "utf8"))[0];
  assertKilled(await read(process.argv[2]), await read(process.argv[3]));
}
