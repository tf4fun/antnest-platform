import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { collectReplayObservation } from "./foundation-trace.mjs";
import { observationEventQuery } from "./replay-history.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const outcome = (pending) =>
  pending.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

async function withObservation(check) {
  const directory = mkdtempSync(join(tmpdir(), "foundation-observation-"));
  mkdirSync(join(directory, "traces"), { mode: 0o700 });
  const controller = new AbortController();
  // Also bounds the old implementation, which does not use injected collectors.
  const timer = setTimeout(
    () => controller.abort(new Error("replay test deadline")),
    1_000,
  );
  const event = {
    event_type: "agent_runtime_condition_changed",
    event_id: "event_observed",
    agent_id: "agent_test",
    schema_version: 1,
    aggregate_sequence: 3,
    global_sequence: 29,
    trace_id: "c".repeat(32),
    occurred_at: "2026-10-10T08:32:57.780789Z",
  };
  const persisted = {
    event_id: event.event_id,
    agent_id: event.agent_id,
    aggregate_sequence: event.aggregate_sequence,
    global_sequence: event.global_sequence,
    schema_version: event.schema_version,
    event_type: event.event_type,
    trace_id: event.trace_id,
    operation_request_id: "",
    data: {
      runtime_revision: "runtime-test",
      runtime_state: "waiting",
      reason: "runtime_restarting",
    },
  };
  const expected = {
    event,
    agentID: event.agent_id,
    runtimeRevision: "runtime-test",
    admissionTraceID: "a".repeat(32),
    replayTraceID: "b".repeat(32),
  };
  const config = {
    evidence: directory,
    // A missing injection must not contact a server during the red baseline.
    jaeger: "foundation-test-unavailable://collector",
    compose: (args) => [
      "compose",
      "-p",
      "foundation-observation-test",
      ...args,
    ],
  };
  const calls = [];
  const f = {
    directory,
    event,
    persisted,
    expected,
    config,
    calls,
    signal: controller.signal,
    inventory: "owned-postgres\n",
    raw: undefined,
    databaseFailure: undefined,
    archive: join(directory, "traces", `${event.event_id}.observation.json`),
    receipt: {
      event_id: event.event_id,
      agent_id: event.agent_id,
      business: "passed",
    },
  };
  f.docker = async (args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1) {
      assert.deepEqual(args, config.compose(["ps", "-q", "postgres"]));
      return f.inventory;
    }
    assert.equal(calls.length, 2, "observation SQL was read more than once");
    assert.deepEqual(args, [
      "exec",
      "owned-postgres",
      "psql",
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_agent_controller",
      "-d",
      "antnest_agent_controller",
      "-c",
      observationEventQuery(event.event_id),
    ]);
    if (f.databaseFailure) throw f.databaseFailure;
    return f.raw ?? JSON.stringify(persisted);
  };
  try {
    return await check(f);
  } finally {
    controller.abort(new Error("replay fixture closed"));
    clearTimeout(timer);
    rmSync(directory, { recursive: true, force: true });
  }
}

function archived(f) {
  assert.equal(statSync(f.archive).mode & 0o777, 0o600);
  return JSON.parse(readFileSync(f.archive, "utf8"));
}

function observationTrace(f) {
  const trace = { traceID: f.event.trace_id, spans: [], processes: {} };
  const add = (spanID, service, operationName, parent, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID: trace.traceID,
      spanID,
      processID: service,
      operationName,
      startTime: 1,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  };
  add(
    "observe",
    "agent-controller",
    "agent_controller.runtime_observation.synchronize",
    null,
    {
      "span.kind": "consumer",
    },
  );
  add("client", "agent-controller", "HTTP GET", "observe", {
    "span.kind": "client",
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "antnest.agent.id": f.expected.agentID,
    "rpc.method": "inspect",
  });
  add(
    "inspect",
    "runtime-controller",
    "GET /internal/runtimes/{agent_id}",
    "client",
    {
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/internal/runtimes/{agent_id}",
      "http.response.status_code": 200,
    },
  );
  add("transaction", "agent-controller", "postgresql transaction", "observe");
  add("insert", "agent-controller", "INSERT", "transaction", {
    "db.query.text":
      "INSERT INTO agent_controller.agent_events (event_id) VALUES ($1)",
  });
  add("commit", "agent-controller", "COMMIT", "transaction");
  return trace;
}

test("replay SQL business succeeds when the injected Trace collector returns 503", async () => {
  await withObservation(async (f) => {
    const diagnostics = createTraceDiagnostics({
      directory: f.directory,
      signal: f.signal,
    });
    const failure = new Error("Jaeger HTTP 503");
    let collected = 0;
    const result = await collectReplayObservation(
      f.config,
      f.docker,
      f.expected,
      [],
      f.signal,
      {
        traceDiagnostics: diagnostics,
        async collectTrace(base, id, inspect, signal) {
          collected++;
          assert.equal(base, f.config.jaeger);
          assert.equal(id, f.event.trace_id);
          assert.equal(typeof inspect, "function");
          assert.ok(signal instanceof AbortSignal);
          assert.equal(f.calls.length, 2);
          assert.deepEqual(archived(f), {
            event: f.event,
            persisted: f.persisted,
          });
          throw failure;
        },
      },
    );
    assert.equal(collected, 1);
    const { diagnostic, ...business } = result;
    assert.deepEqual(business, f.receipt);
    assert.equal(diagnostic.status, "failed");
    assert.equal(Object.hasOwn(diagnostic, "value"), false);
    assert.equal(diagnostics.summary().status, "warning");
    assert.equal(diagnostics.summary().checks.length, 1);
  });
});

test("replay diagnostics retain strict inspection only when actual Span validation succeeds", async () => {
  for (const corrupt of [false, true]) {
    await withObservation(async (f) => {
      const diagnostics = createTraceDiagnostics({
        directory: f.directory,
        signal: f.signal,
      });
      const trace = observationTrace(f);
      if (corrupt)
        trace.spans = trace.spans.filter((span) => span.spanID !== "commit");
      let collected = 0;
      const result = await collectReplayObservation(
        f.config,
        f.docker,
        f.expected,
        [],
        f.signal,
        {
          traceDiagnostics: diagnostics,
          async collectTrace(_base, _id, inspect) {
            collected++;
            assert.deepEqual(archived(f), {
              event: f.event,
              persisted: f.persisted,
            });
            return inspect(trace);
          },
        },
      );
      assert.equal(collected, 1);
      const { diagnostic, ...business } = result;
      assert.deepEqual(business, f.receipt);
      assert.equal(diagnostic.status, corrupt ? "failed" : "passed");
      if (corrupt) assert.equal(Object.hasOwn(diagnostic, "value"), false);
      else {
        assert.equal(diagnostic.value.kind, "runtime-observation");
        assert.equal(diagnostic.value.event_id, f.event.event_id);
        assert.equal(diagnostic.value.trace_id, f.event.trace_id);
        assert.equal(diagnostic.value.strict_trace, "passed");
        assert.equal(diagnostic.value.spans, 6);
      }
      assert.deepEqual(
        JSON.parse(
          readFileSync(
            join(f.directory, "traces", `${trace.traceID}.json`),
            "utf8",
          ),
        ),
        trace,
      );
    });
  }
});

test("replay database ownership persistence and original archive failures stay hard", async () => {
  for (const kind of [
    "ownership",
    "SQL",
    "missing-row",
    "corrupt-row",
    "archive",
  ]) {
    await withObservation(async (f) => {
      const failure = new Error("original SQL observation failed");
      if (kind === "ownership") f.inventory = "";
      if (kind === "SQL") f.databaseFailure = failure;
      if (kind === "missing-row") f.raw = "null";
      if (kind === "corrupt-row")
        f.persisted.data.runtime_revision = "another-runtime";
      if (kind === "archive") mkdirSync(f.archive);
      const diagnostics = createTraceDiagnostics({
        directory: f.directory,
        signal: f.signal,
      });
      let collected = 0;
      await assert.rejects(
        collectReplayObservation(f.config, f.docker, f.expected, [], f.signal, {
          traceDiagnostics: diagnostics,
          async collectTrace() {
            collected++;
            throw new Error("must not collect");
          },
        }),
        (error) => {
          if (kind === "SQL") assert.equal(error, failure);
          else if (kind === "ownership")
            assert.match(
              error.message,
              /one owned evidence database required/u,
            );
          else if (kind === "missing-row")
            assert.match(error.message, /persisted observation event missing/u);
          else if (kind === "corrupt-row")
            assert.match(error.message, /observation target differs/u);
          else assert.equal(error.code, "EISDIR");
          return true;
        },
      );
      assert.equal(f.calls.length, kind === "ownership" ? 1 : 2);
      assert.equal(collected, 0);
      assert.deepEqual(diagnostics.summary().checks, []);
      if (kind === "missing-row" || kind === "corrupt-row")
        assert.deepEqual(archived(f), {
          event: f.event,
          persisted: kind === "missing-row" ? null : f.persisted,
        });
    });
  }
});

test("zero Trace budget still reads validates and archives the original SQL evidence", async () => {
  await withObservation(async (f) => {
    delete f.expected.admissionTraceID;
    delete f.expected.replayTraceID;
    delete f.event.trace_id;
    delete f.persisted.trace_id;
    const diagnostics = createTraceDiagnostics({
      directory: f.directory,
      signal: f.signal,
      budgetMs: 0,
    });
    let collected = 0;
    const result = await collectReplayObservation(
      f.config,
      f.docker,
      f.expected,
      [],
      f.signal,
      {
        traceDiagnostics: diagnostics,
        async collectTrace() {
          collected++;
          throw new Error("budget-exhausted collector ran");
        },
      },
    );
    assert.equal(f.calls.length, 2);
    assert.deepEqual(archived(f), { event: f.event, persisted: f.persisted });
    assert.equal(collected, 0);
    const { diagnostic, ...business } = result;
    assert.deepEqual(business, f.receipt);
    assert.equal(diagnostic.status, "not_collected");
    assert.equal(diagnostic.reason, "diagnostic-budget-exhausted");
    assert.equal(Object.hasOwn(diagnostic, "value"), false);
    assert.equal(diagnostics.summary().status, "warning");
  });
});

test("replay cancellation joins the held collector and parent cancellation stays hard", async () => {
  for (const source of ["diagnostic-budget", "parent"]) {
    await withObservation(async (f) => {
      const parent = new AbortController();
      const signal = AbortSignal.any([parent.signal, f.signal]);
      const reason = new Error("original Foundation parent cancellation");
      const diagnostics = createTraceDiagnostics({
        directory: f.directory,
        signal,
        budgetMs: source === "diagnostic-budget" ? 20 : 1_000,
      });
      const entered = deferred(),
        aborted = deferred(),
        release = deferred(),
        collectorDone = deferred();
      let joined = false,
        settled = false,
        collectorEntered = false;
      const pending = collectReplayObservation(
        f.config,
        f.docker,
        f.expected,
        [],
        signal,
        {
          traceDiagnostics: diagnostics,
          async collectTrace(_base, _id, _inspect, localSignal) {
            assert.deepEqual(archived(f), {
              event: f.event,
              persisted: f.persisted,
            });
            collectorEntered = true;
            entered.resolve();
            let abort;
            try {
              await new Promise((_resolve, reject) => {
                abort = () => {
                  aborted.resolve();
                  reject(localSignal.reason);
                };
                if (localSignal.aborted) abort();
                else
                  localSignal.addEventListener("abort", abort, { once: true });
              });
            } finally {
              try {
                localSignal.removeEventListener("abort", abort);
                await release.promise;
                joined = true;
              } finally {
                collectorDone.resolve();
              }
            }
          },
        },
      );
      const finished = outcome(pending).then((result) => {
        settled = true;
        return result;
      });
      try {
        const first = await Promise.race([
          entered.promise.then(() => "collector-entered"),
          finished.then(() => "returned-before-injected-collector"),
        ]);
        assert.equal(first, "collector-entered");
        if (source === "parent") parent.abort(reason);
        assert.equal(
          await Promise.race([
            aborted.promise.then(() => "collector-aborted"),
            finished.then(() => "returned-before-collector-abort"),
          ]),
          "collector-aborted",
        );
        await Promise.resolve();
        assert.equal(joined, false);
        assert.equal(
          settled,
          false,
          "observation returned before collector cleanup joined",
        );
        release.resolve();
        const result = await finished;
        assert.equal(joined, true);
        if (source === "parent") {
          assert.equal(result.status, "rejected");
          assert.equal(result.reason, reason);
        } else {
          assert.equal(result.status, "fulfilled");
          const { diagnostic, ...business } = result.value;
          assert.deepEqual(business, f.receipt);
          assert.equal(diagnostic.status, "unavailable");
          assert.equal(Object.hasOwn(diagnostic, "value"), false);
        }
      } finally {
        release.resolve();
        parent.abort(new Error("held collector test cleanup"));
        await finished;
        if (collectorEntered) await collectorDone.promise;
      }
    });
  }
});

test("legacy replay collection still rejects a collector failure without an auxiliary profile", async () => {
  await withObservation(async (f) => {
    const failure = new Error("legacy Jaeger HTTP 503");
    let collected = 0;
    await assert.rejects(
      collectReplayObservation(f.config, f.docker, f.expected, [], f.signal, {
        async collectTrace() {
          collected++;
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(collected, 1);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(archived(f), { event: f.event, persisted: f.persisted });
  });
});
