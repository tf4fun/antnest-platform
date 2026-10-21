import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

const url = new URL("./session-trace-policy.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});

function fixture(t) {
  const directory = mkdtempSync(
    join(tmpdir(), "antnest-session-trace-policy-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function collect(options) {
  assert.equal(
    typeof implementation.collectSessionDiagnostics,
    "function",
    "collectSessionDiagnostics must be exported",
  );
  return implementation.collectSessionDiagnostics(options);
}

function bounded(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function heldCollector() {
  const entered = Promise.withResolvers();
  const cleaning = Promise.withResolvers();
  const release = Promise.withResolvers();
  const work = Promise.withResolvers();
  work.promise.catch(() => {});
  let joined = false;
  return {
    entered: entered.promise,
    cleaning: cleaning.promise,
    joined: () => joined,
    async run(signal) {
      assert(signal instanceof AbortSignal);
      const abort = () => work.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      entered.resolve(signal);
      try {
        if (signal.aborted) abort();
        await work.promise;
      } finally {
        signal.removeEventListener("abort", abort);
        cleaning.resolve();
        await release.promise;
        joined = true;
      }
    },
    finish() {
      work.reject(new Error("test collector cleanup"));
      release.resolve();
    },
  };
}

test("successful Session diagnostics preserve the actual owner and request results", async (t) => {
  const directory = fixture(t);
  const ownerTrace = { trace_id: "owner-original" };
  const executionTrace = { trace_id: "request-original" };
  const ownerClose = { original: "owner-close-diagnostic" };
  const ownerDiagnostics = { original: "owner-diagnostic" };
  const expected = { requestId: "request-1" };
  const steps = [];
  const result = await collect({
    directory,
    owner: (signal) => {
      assert(signal instanceof AbortSignal);
      steps.push("owner");
      return Promise.resolve({
        traces: [ownerTrace],
        ownerClose,
        diagnostics: ownerDiagnostics,
      });
    },
    requests: [expected],
    request: (actual, signal) => {
      assert.strictEqual(actual, expected);
      assert(signal instanceof AbortSignal);
      steps.push("request");
      return Promise.resolve(executionTrace);
    },
    strict: (traces) => {
      steps.push("strict");
      assert.deepEqual(traces, [ownerTrace, executionTrace]);
    },
  });
  assert.deepEqual(steps, ["owner", "request", "strict"]);
  assert.deepEqual(result.traces, [ownerTrace]);
  assert.deepEqual(result.executionTraces, [executionTrace]);
  assert.deepEqual(result.ownerClose, ownerClose);
  assert.deepEqual(result.ownerDiagnostics, ownerDiagnostics);
  assert.equal(result.diagnostics.role, "auxiliary");
  assert.equal(result.diagnostics.status, "passed");
});

test("an owner collection failure does not skip any request collection", async (t) => {
  const directory = fixture(t);
  const requests = [{ requestId: "first" }, { requestId: "second" }];
  const steps = [];
  const result = await collect({
    directory,
    owner: () => Promise.reject(new Error("private-owner-collection-secret")),
    requests,
    request: (expected) => {
      steps.push(expected.requestId);
      return Promise.resolve({ request_id: expected.requestId });
    },
    strict: (traces) => {
      steps.push("strict");
      assert.deepEqual(traces, [
        { request_id: "first" },
        { request_id: "second" },
      ]);
    },
  });
  assert.deepEqual(steps, ["first", "second", "strict"]);
  assert.deepEqual(result.traces, []);
  assert.deepEqual(result.executionTraces, [
    { request_id: "first" },
    { request_id: "second" },
  ]);
  assert.equal(result.ownerClose, undefined);
  assert.equal(result.ownerDiagnostics, undefined);
  assert.equal(result.diagnostics.status, "warning");
  assert.equal(
    result.diagnostics.checks.filter((row) => row.status === "failed").length,
    1,
  );
  assert(
    !JSON.stringify(result.diagnostics).includes(
      "private-owner-collection-secret",
    ),
  );
});

test("one failed request leaves later request diagnostics and their results intact", async (t) => {
  const directory = fixture(t);
  const requests = ["first", "second", "third"].map((requestId) => ({
    requestId,
  }));
  const visited = [];
  const result = await collect({
    directory,
    owner: () => Promise.resolve({ traces: [{ trace_id: "owner" }] }),
    requests,
    request: (expected) => {
      visited.push(expected.requestId);
      return expected.requestId === "first"
        ? Promise.reject(new Error("request collection unavailable"))
        : Promise.resolve({ request_id: expected.requestId });
    },
    strict: (traces) =>
      assert.deepEqual(traces, [
        { trace_id: "owner" },
        { request_id: "second" },
        { request_id: "third" },
      ]),
  });
  assert.deepEqual(visited, ["first", "second", "third"]);
  assert.deepEqual(result.executionTraces, [
    { request_id: "second" },
    { request_id: "third" },
  ]);
  assert.equal(result.diagnostics.status, "warning");
  assert.equal(
    result.diagnostics.checks.filter((row) => row.status === "failed").length,
    1,
  );
});

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? "rejected" : "thrown"} strict result is only an auxiliary warning`, async (t) => {
    const directory = fixture(t);
    const failure = new Error("strict topology did not match");
    const trace = { trace_id: "collected-owner" };
    const result = await collect({
      directory,
      owner: () => Promise.resolve({ traces: [trace] }),
      requests: [],
      request: () => assert.fail("no request was supplied"),
      strict: () => {
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      },
    });
    assert.deepEqual(result.traces, [trace]);
    assert.deepEqual(result.executionTraces, []);
    assert.equal(result.diagnostics.status, "warning");
    assert.equal(result.diagnostics.checks.at(-1).status, "failed");
  });
}

test("an exhausted shared budget records uncollected work without invoking it", async (t) => {
  const directory = fixture(t);
  const invoked = [];
  const result = await collect({
    directory,
    budgetMs: 0,
    owner: () => {
      invoked.push("owner");
      return Promise.resolve({ traces: [] });
    },
    requests: [{ requestId: "first" }, { requestId: "second" }],
    request: (expected) => {
      invoked.push(expected.requestId);
      return Promise.resolve({ request_id: expected.requestId });
    },
    strict: () => invoked.push("strict"),
  });
  assert.deepEqual(invoked, []);
  assert.deepEqual(result.traces, []);
  assert.deepEqual(result.executionTraces, []);
  assert.equal(result.ownerClose, undefined);
  assert.equal(result.diagnostics.status, "warning");
  assert.equal(result.diagnostics.checks.length, 4);
  assert(
    result.diagnostics.checks.every((row) => row.status === "not_collected"),
  );
});

test("the shared deadline cancels and joins the collector before returning", async (t) => {
  const directory = fixture(t);
  const controller = new AbortController();
  const collector = heldCollector();
  let settled = false;
  const pending = collect({
    directory,
    signal: controller.signal,
    budgetMs: 10,
    owner: (signal) => collector.run(signal),
    requests: [{ requestId: "after-deadline" }],
    request: () =>
      assert.fail("request received a fresh budget after exhaustion"),
    strict: () =>
      assert.fail("strict received a fresh budget after exhaustion"),
  });
  const outcome = pending.then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  try {
    const localSignal = await bounded(
      collector.entered,
      "owner collection entered",
    );
    await bounded(collector.cleaning, "deadline reached collector finally");
    assert.equal(localSignal.aborted, true);
    assert.equal(controller.signal.aborted, false);
    await nextTurn();
    assert.equal(settled, false, "collector finally was abandoned");
    assert.equal(collector.joined(), false);
    collector.finish();
    const result = await bounded(outcome, "diagnostics joined");
    assert.equal(result.error, undefined);
    assert.equal(collector.joined(), true);
    assert.deepEqual(result.value.traces, []);
    assert.deepEqual(result.value.executionTraces, []);
    assert.equal(result.value.diagnostics.status, "warning");
    assert.deepEqual(
      result.value.diagnostics.checks.map((row) => row.status),
      ["unavailable", "not_collected", "not_collected"],
    );
  } finally {
    controller.abort(new Error("test cleanup"));
    collector.finish();
    await bounded(outcome, "deadline test cleanup joined");
  }
});

test("a pre-aborted parent invokes no diagnostics and preserves its original reason", async (t) => {
  const directory = fixture(t);
  const controller = new AbortController();
  const reason = new Error("suite already cancelled");
  const invoked = [];
  controller.abort(reason);
  await assert.rejects(
    async () =>
      collect({
        directory,
        signal: controller.signal,
        owner: () => {
          invoked.push("owner");
          return Promise.resolve({ traces: [] });
        },
        requests: [{ requestId: "first" }],
        request: (expected) => {
          invoked.push(expected.requestId);
          return Promise.resolve({ request_id: expected.requestId });
        },
        strict: () => invoked.push("strict"),
      }),
    (error) => error === reason,
  );
  assert.deepEqual(invoked, []);
});

for (const phase of ["owner", "request"]) {
  test(`parent cancellation during ${phase} joins its collector and remains fatal`, async (t) => {
    const directory = fixture(t);
    const controller = new AbortController();
    const reason = new Error("suite cancelled during collection");
    const collector = heldCollector();
    const visited = [];
    let settled = false;
    const pending = collect({
      directory,
      signal: controller.signal,
      budgetMs: 5000,
      owner: (signal) =>
        phase === "owner"
          ? collector.run(signal)
          : Promise.resolve({ traces: [{ trace_id: "owner" }] }),
      requests: [{ requestId: "first" }, { requestId: "second" }],
      request: (expected, signal) => {
        visited.push(expected.requestId);
        assert.equal(expected.requestId, "first");
        return collector.run(signal);
      },
      strict: () => visited.push("strict"),
    });
    const outcome = pending.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    try {
      const localSignal = await bounded(
        collector.entered,
        `${phase} collection entered`,
      );
      controller.abort(reason);
      await bounded(collector.cleaning, "parent cancellation reached finally");
      assert.strictEqual(localSignal.reason, reason);
      await nextTurn();
      assert.equal(
        settled,
        false,
        "parent cancellation abandoned collector finally",
      );
      collector.finish();
      const result = await bounded(outcome, "cancelled diagnostics joined");
      assert.strictEqual(result.error, reason);
      assert.equal(result.value, undefined);
      assert.equal(collector.joined(), true);
      assert.deepEqual(visited, phase === "owner" ? [] : ["first"]);
    } finally {
      controller.abort(new Error("test cleanup"));
      collector.finish();
      await bounded(outcome, "parent cancellation test cleanup joined");
    }
  });
}

test("an unavailable diagnostic archive does not hide later request collectors", async (t) => {
  const directory = fixture(t);
  const visited = [];
  const result = await collect({
    directory,
    owner: () => {
      rmSync(directory, { recursive: true, force: true });
      writeFileSync(directory, "diagnostic archive is unavailable");
      return Promise.reject(new Error("owner trace unavailable"));
    },
    requests: [{ requestId: "first" }, { requestId: "second" }],
    request: (expected) => {
      visited.push(expected.requestId);
      return Promise.resolve({ request_id: expected.requestId });
    },
    strict: () => visited.push("strict"),
  });
  assert.deepEqual(visited, ["first", "second", "strict"]);
  assert.deepEqual(result.executionTraces, [
    { request_id: "first" },
    { request_id: "second" },
  ]);
  assert.equal(result.diagnostics.status, "warning");
  assert(result.diagnostics.checks.some((row) => row.evidence_error_type));
});
