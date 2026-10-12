import assert from "node:assert/strict";
import test from "node:test";
import { joinRecoveryRun } from "./resolve-cache-recovery-cleanup.mjs";

function fixture() {
  const request = {
    phase: "c4-browser-hold-logout",
    stage: "reply",
    trace_id: "a".repeat(32),
    model_span_id: "b".repeat(16),
    received_at_ms: 1,
  };
  const c = {
    phase: request.phase,
    run_id: "run",
    session_id: "session",
    prompt: { trace_id: request.trace_id },
    model_started: { state: { requests: [request] } },
    failure: { message: "original business failure" },
  };
  const held = {
    at: 1,
    state: { errors: [], pending: [request.phase], requests: [{ ...request }] },
  };
  const terminal = {
    at: 2,
    body: {
      run_id: "run",
      session_id: "session",
      state: "completed",
      executor_state: "quiescent",
      tool_effect_state: "none",
    },
  };
  return { c, held, terminal };
}

test("failure cleanup joins held work without replacing business failure or release evidence", async () => {
  const f = fixture(),
    releasing = Promise.withResolvers(),
    started = Promise.withResolvers();
  let settled = false,
    releases = 0;
  const job = joinRecoveryRun({
    ...f,
    model: async () => f.held,
    release: async () => {
      releases++;
      started.resolve();
      await releasing.promise;
      return { status: 200 };
    },
    audit: async () => f.terminal,
  }).then(() => {
    settled = true;
  });
  await started.promise;
  assert.equal(settled, false);
  releasing.resolve();
  await job;
  assert.equal(releases, 1);
  assert.equal(settled, true);
  assert.equal(f.c.failure.message, "original business failure");
  assert.equal(f.c.release, undefined);
  assert.equal(f.c.failure_cleanup.audit.body.run_id, "run");
  assert.equal(f.c.failure_cleanup.status, "joined");
});

test("caller interruption still gives owned cleanup its independent bounded signal", async () => {
  const f = fixture(),
    stopped = new AbortController();
  stopped.abort(new Error("caller stopped"));
  await joinRecoveryRun({
    ...f,
    signal: stopped.signal,
    model: async (signal) => {
      assert(!signal.aborted);
      return f.held;
    },
    release: async (signal) => {
      assert(!signal.aborted);
      return { status: 200 };
    },
    audit: async (signal) => {
      assert(!signal.aborted);
      return f.terminal;
    },
  });
  assert.equal(f.c.failure_cleanup.caller_aborted, true);
  assert.equal(f.c.failure_cleanup.status, "joined");
});

test("accepted Run interrupted before first model receipt is still joined", async () => {
  const f = fixture(),
    stopped = new AbortController();
  delete f.c.model_started;
  stopped.abort(new Error("first model status interrupted"));
  await joinRecoveryRun({
    ...f,
    signal: stopped.signal,
    model: async (signal) => {
      assert(!signal.aborted);
      return f.held;
    },
    release: async () => ({ status: 200 }),
    audit: async () => f.terminal,
  });
  assert.equal(f.c.failure_cleanup.status, "joined");
  assert.equal(f.c.failure_cleanup.baseline_source, "cleanup-status");
  assert.equal(f.c.release, undefined);
  assert.equal(f.c.failure.message, "original business failure");
});

test("cleanup waits for an accepted Run whose model request has not arrived yet", async () => {
  const f = fixture();
  delete f.c.model_started;
  let reads = 0;
  await joinRecoveryRun({
    ...f,
    model: async () =>
      ++reads === 1
        ? { ...f.held, state: { errors: [], pending: [], requests: [] } }
        : f.held,
    release: async () => ({ status: 200 }),
    audit: async () =>
      reads === 1
        ? {
            ...f.terminal,
            body: {
              ...f.terminal.body,
              state: "running",
              executor_state: null,
            },
          }
        : f.terminal,
    wait: async () => {},
  });
  assert.equal(f.c.failure_cleanup.status, "joined");
  assert.equal(reads, 2);
});

for (const [label, mutate] of [
  [
    "foreign prompt",
    (f) => {
      f.held.state.requests[0].trace_id = "c".repeat(32);
    },
  ],
  [
    "replacement model request",
    (f) => {
      f.held.state.requests[0].model_span_id = "c".repeat(16);
    },
  ],
  [
    "replacement model receipt",
    (f) => {
      f.held.state.requests[0].received_at_ms = 2;
    },
  ],
])
  test(`cleanup never releases ${label}`, async () => {
    const f = fixture();
    mutate(f);
    let releases = 0;
    await assert.rejects(
      joinRecoveryRun({
        ...f,
        model: async () => f.held,
        release: async () => {
          releases++;
          return { status: 200 };
        },
        audit: async () => f.terminal,
      }),
    );
    assert.equal(releases, 0);
    assert.equal(f.c.failure.message, "original business failure");
    assert.equal(f.c.failure_cleanup.status, "failed");
  });

test("cleanup has a finite bound and preserves its separate failure", async () => {
  const f = fixture();
  await assert.rejects(
    joinRecoveryRun({
      ...f,
      timeoutMS: 20,
      model: async () => f.held,
      release: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
      audit: async () => f.terminal,
    }),
  );
  assert.equal(f.c.failure_cleanup.status, "failed");
  assert.equal(f.c.failure.message, "original business failure");
});

test("cleanup waits for the same Run to become quiescent and does not release twice", async () => {
  const f = fixture();
  let reads = 0,
    releases = 0;
  await joinRecoveryRun({
    ...f,
    model: async () => f.held,
    release: async () => {
      releases++;
      return { status: 200 };
    },
    audit: async () =>
      ++reads === 1
        ? {
            ...f.terminal,
            body: {
              ...f.terminal.body,
              state: "running",
              executor_state: null,
            },
          }
        : f.terminal,
    wait: async () => {},
  });
  assert.equal(reads, 2);
  assert.equal(releases, 1);
});

test("cleanup rejects a foreign terminal audit", async () => {
  const f = fixture();
  f.terminal.body.run_id = "other";
  await assert.rejects(
    joinRecoveryRun({
      ...f,
      model: async () => f.held,
      release: async () => ({ status: 200 }),
      audit: async () => f.terminal,
    }),
  );
});
