import assert from "node:assert/strict";
import test from "node:test";
import { c4InventoryFixture } from "./c4-inventory.fixture.mjs";

const url = new URL("./c4-runtime.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});

function fixture() {
  const source = c4InventoryFixture(),
    events = [],
    report = { agent_id: source.agent_id },
    config = { project: "c4-owned", resolvedImage: source.runtime_image_id },
    abort = new AbortController();
  let current = 0;
  const args = {
    report,
    config,
    signal: abort.signal,
    fixture: {
      agentID: source.agent_id,
      async ready() {
        events.push("ready");
        return structuredClone(source.runtime_bindings[current].observed.agent);
      },
    },
    async docker(args) {
      events.push("inspect");
      assert.deepEqual(args, [
        "inspect",
        source.runtime_bindings[current].observed.container.Id,
      ]);
      return JSON.stringify([
        source.runtime_bindings[current].observed.container,
      ]);
    },
  };
  const dependencies = {
    async physical(docker, actualConfig, agentId) {
      events.push("physical");
      assert.equal(docker, args.docker);
      assert.equal(actualConfig, config);
      assert.equal(agentId, source.agent_id);
      const { observed } = source.runtime_bindings[current];
      return {
        id: observed.container.Id,
        volume: observed.volume,
        running: true,
        healthy: true,
      };
    },
    async status(docker, project, runtimeId, options) {
      events.push("status");
      assert.equal(docker, args.docker);
      assert.equal(project, config.project);
      assert.equal(
        runtimeId,
        source.runtime_bindings[current].observed.container.Id,
      );
      assert.equal(options.signal, abort.signal);
      return structuredClone(source.runtime_bindings[current].status);
    },
  };
  return {
    source,
    args,
    dependencies,
    events,
    report,
    abort,
    next() {
      current++;
    },
  };
}

const capture = (name, f) => {
  assert.equal(typeof implementation.captureC4Runtime, "function");
  return implementation.captureC4Runtime(name, f.args, f.dependencies);
};

test("C4 binds each original physical Runtime to its own fresh ready response", async () => {
  const f = fixture();
  await capture("initial", f);
  f.next();
  await capture("rebuilt", f);
  assert.deepEqual(f.report.runtime_bindings, f.source.runtime_bindings);
  assert.equal(f.report.runtime_image_id, f.args.config.resolvedImage);
  assert.deepEqual(f.events, [
    "ready",
    "physical",
    "inspect",
    "status",
    "ready",
    "physical",
    "inspect",
    "status",
  ]);
});

for (const [name, change] of [
  [
    "foreign Agent status",
    (f) => {
      f.source.runtime_bindings[0].status.agent_id = "other";
    },
  ],
  [
    "stale generation",
    (f) => {
      f.source.runtime_bindings[0].status.generation = 2;
    },
  ],
  [
    "different image",
    (f) => {
      f.source.runtime_bindings[0].observed.container.Image = "sha256:other";
    },
  ],
  [
    "unhealthy Runtime",
    (f) => {
      f.source.runtime_bindings[0].observed.container.State.Health.Status =
        "unhealthy";
    },
  ],
  [
    "missing workspace",
    (f) => {
      f.source.runtime_bindings[0].observed.volume = "";
    },
  ],
])
  test(`C4 rejects ${name} without inventing a Runtime binding`, async () => {
    const f = fixture();
    change(f);
    assert.equal(typeof implementation.captureC4Runtime, "function");
    await assert.rejects(() => capture("initial", f));
    assert.equal(f.report.runtime_bindings?.[0]?.binding, undefined);
  });

test("C4 retains the original failed status observation and error", async () => {
  const f = fixture(),
    failure = new Error("original status read failed");
  f.dependencies.status = async () => {
    throw failure;
  };
  assert.equal(typeof implementation.captureC4Runtime, "function");
  await assert.rejects(
    () => capture("initial", f),
    (error) => error === failure,
  );
  assert.deepEqual(
    f.report.runtime_bindings[0].observed,
    f.source.runtime_bindings[0].observed,
  );
  assert.equal(f.report.runtime_bindings[0].binding, undefined);
});

test("C4 retains successful Agent and physical reads when container inspection fails", async () => {
  const f = fixture(),
    failure = new Error("original inspect failure");
  f.args.docker = async () => {
    throw failure;
  };
  assert.equal(typeof implementation.captureC4Runtime, "function");
  await assert.rejects(
    () => capture("initial", f),
    (error) => error === failure,
  );
  assert.deepEqual(
    f.report.runtime_bindings[0].physical,
    f.source.runtime_bindings[0].physical,
  );
  assert.deepEqual(f.report.runtime_bindings[0].observed, {
    agent: f.source.runtime_bindings[0].observed.agent,
    volume: f.source.runtime_bindings[0].observed.volume,
  });
  assert.equal(f.report.runtime_bindings[0].binding, undefined);
});

test("C4 stops starting Runtime reads after cancellation", async () => {
  const f = fixture(),
    physical = f.dependencies.physical;
  f.dependencies.physical = async (...args) => {
    const result = await physical(...args);
    f.abort.abort(new Error("stopped"));
    return result;
  };
  assert.equal(typeof implementation.captureC4Runtime, "function");
  await assert.rejects(() => capture("initial", f), /stopped/u);
  assert.deepEqual(f.events, ["ready", "physical"]);
  assert.deepEqual(
    f.report.runtime_bindings[0].physical,
    f.source.runtime_bindings[0].physical,
  );
  assert.deepEqual(
    f.report.runtime_bindings[0].observed.agent,
    f.source.runtime_bindings[0].observed.agent,
  );
});

test("C4 does not replace an earlier Runtime observation", async () => {
  const f = fixture();
  await capture("initial", f);
  const original = structuredClone(f.report);
  await assert.rejects(() => capture("initial", f));
  assert.deepEqual(f.report, original);
});
