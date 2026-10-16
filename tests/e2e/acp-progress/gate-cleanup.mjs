import assert from "node:assert/strict";

// Keep the immutable ID returned by this run's successful create. If creation
// was interrupted, recover only the container carrying this run's unique label.
export async function cleanupProgressProbe({ run, containerID, docker, save }) {
  assert.match(run, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  const owner = "io.antnest.progress-gate-probe";
  const name = `antnest-runtime-agent_${run.replaceAll("-", "")}`;
  let ids;
  if (containerID !== undefined) {
    assert.match(containerID, /^[a-f0-9]{64}$/u);
    ids = [containerID];
  } else {
    ids = (
      await docker([
        "container",
        "ls",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=${owner}=${run}`,
      ])
    )
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    assert(ids.length <= 1);
    for (const id of ids) assert.match(id, /^[a-f0-9]{64}$/u);
  }
  const errors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      if (!errors.includes(error)) errors.push(error);
    }
  };
  for (const id of ids) {
    await attempt(async () => {
      const raw = await docker(["container", "inspect", id]);
      const rows = JSON.parse(raw);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].Id, id);
      assert.equal(rows[0].Name, "/" + name);
      assert.equal(rows[0].Config.Labels[owner], run);
      await save("final-container-inspect.json", raw + "\n");
    });
    await attempt(async () =>
      save(
        "container.log",
        await docker(["logs", id], false, { captureStderr: true }),
      ),
    );
    await attempt(() => docker(["rm", "--force", "--volumes", id]));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Progress probe cleanup failed");
}
