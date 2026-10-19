import assert from "node:assert/strict";
import test from "node:test";
import { note } from "./browser-model.mjs";
const url = new URL("./c4-actions.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture(overrides = {}) {
  assert.equal(typeof implementation.createC4Actions, "function");
  const abort = new AbortController(),
    report = { checks: [], traces: [] },
    events = [];
  const config = {
    project: "antnest-lifecycle-12345678",
    env: {},
    model: "http://model.test",
    compose: (args) => ["compose", ...args],
  };
  const container = {
    Id: "ui",
    Config: {
      Labels: {
        "com.docker.compose.project": config.project,
        "com.docker.compose.service": "agent-ui",
      },
    },
    State: { Running: false, ExitCode: 0, OOMKilled: false },
  };
  const dependencies = {
    createDocker: (_env, signal) => async (args) => {
      events.push({ args, signal });
      if (args[0] === "inspect") return JSON.stringify([container]);
      if (args.includes("ps")) return "ui";
      return "";
    },
    flushShared: async () => {
      events.push({ shared: true });
      return 7;
    },
    write: () => {},
    ...overrides,
  };
  return {
    abort,
    report,
    config,
    events,
    container,
    actions: implementation.createC4Actions(
      {
        signal: abort.signal,
        report,
        output: "artifacts/verification/c4-test",
      },
      dependencies,
    ),
  };
}
test("C4 workspace bytes remain bound to the full rebuilt container identity", async () => {
  const id = "a".repeat(64),
    member = { agentID: "agent" },
    captures = [];
  const f = fixture({
    setup: async () => member,
    captureRuntime: async (name) => {
      captures.push(name);
    },
    createDocker: () => async (args) =>
      args[0] === "ps"
        ? args.includes("--no-trunc")
          ? id
          : id.slice(0, 12)
        : Buffer.from(note).toString("base64"),
  });
  const actual = await f.actions.setup(f.config, f.report);
  await actual.verifyWorkspace();
  assert.deepEqual(captures, ["initial"]);
  assert.equal(f.report.workspace_receipt.container_id, id);
  assert.equal(
    Buffer.from(f.report.workspace_receipt.encoded, "base64").toString(),
    note,
  );
});
test("C4 business completion cannot bypass missing browser acceptance checks", () => {
  const f = fixture();
  assert.throws(
    () => f.actions.admit(f.report, f.config),
    /browser business incomplete/u,
  );
  f.report.business_completed = true;
  assert.throws(
    () => f.actions.admit(f.report, f.config),
    /complete C4 browser checks/u,
  );
});
test("C4 action captures its owned project before configuration can fail", async () => {
  const error = new Error("original configure failure");
  const f = fixture({
    configuration: async (_signal, allocated) => {
      allocated("antnest-lifecycle-12345678");
      throw error;
    },
  });
  let scope;
  await assert.rejects(
    f.actions.configure((value) => {
      scope = value;
    }),
    (e) => e === error,
  );
  assert.equal(scope.project, f.config.project);
  assert(scope.env);
});
test("C4 flush joins Agent UI before all seven shared producers", async () => {
  const f = fixture();
  await f.actions.flush(f.config, f.report);
  assert(f.events[0].args.includes("stop"));
  assert(f.events[0].args.includes("agent-ui"));
  assert.equal(f.events.at(-1).shared, true);
  assert.deepEqual(f.report.producer_flush.agent_ui, f.container);
  assert.equal(f.report.producer_flush.shared_services, 7);
});
test("C4 still flushes independent shared producers after an Agent UI flush failure", async () => {
  const original = new Error("original UI flush error");
  let shared = 0;
  const f = fixture({
    createDocker: () => async () => {
      throw original;
    },
    flushShared: async () => {
      shared++;
      return 7;
    },
  });
  await assert.rejects(
    f.actions.flush(f.config, f.report),
    (e) => e === original || e.errors.includes(original),
  );
  assert.equal(shared, 1);
  assert.equal(f.report.producer_flush.completed, undefined);
});
test("C4 refresh reads a new model observation when refreshing execution audits", async () => {
  const fresh = { requests: [], pending: [], errors: [] };
  const f = fixture({
    request: async () => Response.json(fresh),
    snapshot: async (_fixture, model) => ({
      audits: { all: [] },
      model: await model(),
    }),
  });
  f.report.model = { requests: ["stale"] };
  await f.actions.refreshAudits(f.config, {}, f.report);
  assert.deepEqual(f.report.execution.model, fresh);
  assert.deepEqual(f.report.model, { requests: ["stale"] });
});
test("C4 failure logs and cleanup use an independent signal after parent interruption", async () => {
  let cleaned;
  const f = fixture({
    cleanup: async (config) => {
      cleaned = config;
    },
  });
  f.abort.abort(new Error("parent interrupted"));
  await f.actions.logs(f.config, f.report);
  assert(f.events.length > 0);
  assert(f.events.every((event) => event.signal === undefined));
  await f.actions.cleanup(f.config, f.report);
  assert.equal(cleaned.project, f.config.project);
});
