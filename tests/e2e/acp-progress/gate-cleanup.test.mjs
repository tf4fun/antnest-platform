import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./gate-cleanup.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const run = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855",
  id = "a".repeat(64);
const owner = "io.antnest.progress-gate-probe";
const container = `antnest-runtime-agent_${run.replaceAll("-", "")}`;
function entry() {
  assert.equal(typeof implementation.cleanupProgressProbe, "function");
  return implementation.cleanupProgressProbe;
}
function fixture(failures = {}) {
  const calls = [],
    saved = [];
  return {
    calls,
    saved,
    options: {
      run,
      containerID: id,
      docker: async (args) => {
        calls.push(args);
        const stage = args[0] === "container" ? args[1] : args[0];
        if (Object.hasOwn(failures, stage)) throw failures[stage];
        if (stage === "inspect")
          return JSON.stringify([
            {
              Id: id,
              Name: "/" + container,
              Config: { Labels: { [owner]: run } },
            },
          ]);
        if (stage === "ls") return id;
        return "fixture logs";
      },
      save: async (file, raw) => {
        saved.push({ file, raw });
        if (Object.hasOwn(failures, "save")) throw failures.save;
      },
    },
  };
}
for (const stage of ["inspect", "save", "logs"])
  test(
    "owned container removal is still attempted after failed " + stage,
    async () => {
      const cleanup = entry(),
        original = new Error(stage),
        f = fixture({ [stage]: original });
      await assert.rejects(cleanup(f.options), (error) => error === original);
      assert.deepEqual(f.calls.at(-1), ["rm", "--force", "--volumes", id]);
    },
  );
test("diagnostic and removal failures retain both original errors", async () => {
  const cleanup = entry(),
    original = new Error("evidence"),
    removal = new Error("remove");
  const f = fixture({ save: original, rm: removal });
  await assert.rejects(
    cleanup(f.options),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(original) &&
      error.errors.includes(removal),
  );
});
test("cleanup uses the immutable create ID without relying on a later listing", async () => {
  const cleanup = entry(),
    f = fixture({ ls: new Error("list unavailable") });
  await cleanup(f.options);
  assert(!f.calls.some((args) => args[1] === "ls"));
  assert.equal(f.saved.length, 2);
});
test("an interrupted create without an ID locates only this run's labelled container", async () => {
  const cleanup = entry(),
    f = fixture();
  delete f.options.containerID;
  await cleanup(f.options);
  assert.deepEqual(f.calls[0], [
    "container",
    "ls",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=${owner}=${run}`,
  ]);
  assert.deepEqual(f.calls.at(-1), ["rm", "--force", "--volumes", id]);
});
test("invalid container identity cannot reach Docker", async () => {
  const cleanup = entry(),
    f = fixture();
  f.options.containerID = "foreign";
  await assert.rejects(cleanup(f.options));
  assert.deepEqual(f.calls, []);
});
