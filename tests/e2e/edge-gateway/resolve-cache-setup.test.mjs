import assert from "node:assert/strict";
import test from "node:test";
import { setupResolveCache } from "./resolve-cache-setup.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => (resolve = complete));
  return { promise, resolve };
}

function fixture() {
  const calls = [],
    controller = new AbortController(),
    config = { env: { ANTNEST_EDGE_REQUEST_TIMEOUT: "150s" } },
    created = {
      agent: { agent_id: "cold-agent" },
      operation: { request_id: "create-cold-agent" },
    },
    ready = {
      agent_id: "cold-agent",
      owner_user_id: "owner",
      lifecycle_state: "created",
      activation_state: "enabled",
      desired_state: "enabled",
      runtime_state: "available",
      executable_execution_revision: "execution-1",
      runtime: { runtime_revision: "runtime-1" },
    },
    controls = {
      create: async () => created,
      operation: async () => ({ state: "completed" }),
      readiness: async (read) => read(),
    };
  let time = 0;
  const base = {
    agentID: "warm-agent",
    ownerID: "owner",
    template: { template_id: "template", revision: "revision" },
    async json(path, options) {
      if (path === "/api/admin/agents") {
        calls.push("create");
        assert.equal(config.env.ANTNEST_EDGE_REQUEST_TIMEOUT, "150s");
        assert.equal(options.status, 202);
        assert.deepEqual(options.body, {
          owner_user_id: "owner",
          name: "Cold cache Agent",
          template_id: "template",
          template_revision: "revision",
        });
        return controls.create();
      }
      assert.equal(path, "/api/admin/agents/cold-agent");
      calls.push("read-agent");
      return ready;
    },
    async operation(id) {
      calls.push("operation");
      assert.equal(id, created.operation.request_id);
      return controls.operation();
    },
  };
  const dependencies = {
    async setup(actualConfig, signal) {
      assert.equal(actualConfig, config);
      assert.equal(signal, controller.signal);
      calls.push("workspace");
      return base;
    },
    async waitReady(read, signal) {
      assert.equal(signal, controller.signal);
      calls.push("wait-ready");
      return controls.readiness(read);
    },
    now: () => ++time,
  };
  return {
    calls,
    config,
    controller,
    created,
    ready,
    controls,
    base,
    dependencies,
  };
}

test("cache setup waits for single cold Agent creation, operation and readiness", async () => {
  const f = fixture(),
    operationStarted = deferred(),
    operationReleased = deferred(),
    readinessStarted = deferred(),
    readinessReleased = deferred();
  f.controls.operation = async () => {
    operationStarted.resolve();
    await operationReleased.promise;
    return { state: "completed" };
  };
  f.controls.readiness = async (read) => {
    readinessStarted.resolve();
    await readinessReleased.promise;
    return read();
  };
  let finished = false;
  const running = setupResolveCache(
    f.config,
    f.controller.signal,
    f.dependencies,
  ).finally(() => {
    finished = true;
  });
  try {
    await Promise.race([operationStarted.promise, running]);
    assert.equal(finished, false);
    assert.deepEqual(f.calls, ["workspace", "create", "operation"]);
    operationReleased.resolve();
    await Promise.race([readinessStarted.promise, running]);
    assert.equal(finished, false);
    readinessReleased.resolve();
    const result = await running;
    assert.equal(result.json, f.base.json);
    assert.equal(result.coldAgentID, "cold-agent");
    assert.deepEqual(result.coldAgentSetup, {
      request_timeout_ms: 150000,
      agent_id: "cold-agent",
      owner_user_id: "owner",
      request_id: "create-cold-agent",
      executable_execution_revision: "execution-1",
      runtime_revision: "runtime-1",
      started_at: 1,
      created_at: 2,
      ready_at: 3,
    });
    assert.equal(f.calls.filter((call) => call === "create").length, 1);
    assert.equal(f.config.env.ANTNEST_EDGE_REQUEST_TIMEOUT, "150s");
  } finally {
    operationReleased.resolve();
    readinessReleased.resolve();
    await running.catch(() => {});
  }
});

test("cache setup rejects the outage request budget before any provisioning", async () => {
  const f = fixture();
  f.config.env.ANTNEST_EDGE_REQUEST_TIMEOUT = "2s";
  await assert.rejects(
    setupResolveCache(f.config, f.controller.signal, f.dependencies),
    /provisioning budget/u,
  );
  assert.deepEqual(f.calls, []);
});

for (const stage of ["create", "operation", "readiness"]) {
  test(`cache setup does not retry after ${stage} fails`, async () => {
    const f = fixture(),
      failure = new Error("original failure");
    f.controls[stage] = async () => {
      throw failure;
    };
    await assert.rejects(
      setupResolveCache(f.config, f.controller.signal, f.dependencies),
      (error) => error === failure,
    );
    assert.equal(f.calls.filter((call) => call === "create").length, 1);
  });
}

for (const [name, change] of [
  [
    "same Agent",
    (f) => {
      f.created.agent.agent_id = f.base.agentID;
    },
  ],
  [
    "missing operation",
    (f) => {
      f.created.operation.request_id = "";
    },
  ],
  [
    "wrong ready Agent",
    (f) => {
      f.ready.agent_id = "foreign-agent";
    },
  ],
  [
    "wrong owner",
    (f) => {
      f.ready.owner_user_id = "foreign-owner";
    },
  ],
  [
    "unready Runtime",
    (f) => {
      f.ready.runtime_state = "unavailable";
    },
  ],
]) {
  test(`cache setup rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(
      setupResolveCache(f.config, f.controller.signal, f.dependencies),
    );
    assert.equal(f.calls.filter((call) => call === "create").length, 1);
  });
}

test("cache setup propagates cancellation before creating the cold Agent", async () => {
  const f = fixture(),
    setup = f.dependencies.setup;
  f.dependencies.setup = async (...args) => {
    const result = await setup(...args);
    f.controller.abort();
    return result;
  };
  await assert.rejects(
    setupResolveCache(f.config, f.controller.signal, f.dependencies),
    { name: "AbortError" },
  );
  assert.deepEqual(f.calls, ["workspace"]);
});
