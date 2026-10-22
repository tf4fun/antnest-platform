import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { withPrivateCommandResources } from "../acp-commands/connection.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

const url = new URL("./diagnostics.mjs", import.meta.url);
const { collectPlanTraceDiagnostics: collect } = await import(url).catch(
  (error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
      return {};
    throw error;
  },
);
const all = (inventory) => [
  ...inventory.setupRequests,
  ...inventory.executionRequests,
  ...inventory.replayRequests,
  ...inventory.initializationRequests,
];
function fixture(t) {
  assert.equal(
    typeof collect,
    "function",
    "collectPlanTraceDiagnostics is required",
  );
  const directory = mkdtempSync(join(tmpdir(), "antnest-plan-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    inventory: {
      setupRequests: [{ label: "new", method: "session/new" }],
      executionRequests: [
        { label: "v1-execute", phase: "v1-execute", method: "session/prompt" },
      ],
      replayRequests: [
        {
          label: "foreign-new",
          method: "session/new",
          denial: "access_denied",
        },
      ],
      initializationRequests: [{ label: "initialize", method: "initialize" }],
      runtimeInspection: {
        runtimes: [{ agent_id: "agent-v1", generation: 7 }],
      },
    },
    requests: [{ phase: "v1-execute" }],
  };
}
const check = (result, name) => {
  const rows = result.trace_diagnostics.checks.filter(
    (row) => row.name === name,
  );
  assert.equal(rows.length, 1);
  return rows[0];
};
function placeholder(row, label, index, status = "failed") {
  assert.deepEqual(Object.keys(row).sort(), ["diagnostic", "label"]);
  assert.equal(row.label, label);
  assert.equal(row.diagnostic.name, `plan-request-${index}`);
  assert.equal(row.diagnostic.status, status);
  assert.equal(Object.hasOwn(row, "trace_id"), false);
  assert.equal(Object.hasOwn(row, "run_id"), false);
}
function privateFailures(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".private.txt"))
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n");
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Plan retains old canonical matching, collector 503 and missing Trace errors privately and continues", async (t) => {
  const f = fixture(t),
    calls = [];
  const errors = [
    new Error("PRIVATE_503_CANARY", {
      cause: { status: 503, authorization: "PRIVATE_HEADER_CANARY" },
    }),
    new Error("PRIVATE_MISSING_TRACE_CANARY"),
    new AssertionError({
      actual: -32010,
      expected: -32020,
      operator: "strictEqual",
      message: "PRIVATE_CANONICAL_CANARY",
    }),
  ];
  const initialization = { trace_id: "collected-initialize" };
  const result = await collect("http://jaeger:16686", f.inventory, {
    directory: f.directory,
    requests: f.requests,
    collectRequest: async (base, expected, options) => {
      assert.equal(base, "http://jaeger:16686");
      assert(options.signal instanceof AbortSignal);
      assert.strictEqual(options.requests, f.requests);
      const index = calls.length;
      calls.push(expected);
      if (index < errors.length) throw errors[index];
      return initialization;
    },
  });
  assert.deepEqual(calls, all(f.inventory));
  for (let index = 0; index < 3; index++)
    placeholder(result.checked[index], calls[index].label, index);
  assert.strictEqual(result.checked[3], initialization);
  assert.equal(result.trace_diagnostics.role, "auxiliary");
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(check(result, "plan-trace-inventory").status, "failed");
  assert.equal(check(result, "plan-strict-trace-result").status, "failed");
  assert.deepEqual(result.strict, {
    strict_trace: "failed",
    accepted: false,
    exit_code: 1,
  });
  assert.doesNotMatch(JSON.stringify(result.trace_diagnostics), /PRIVATE_/u);
  const raw = privateFailures(f.directory);
  for (const marker of [
    "PRIVATE_CANONICAL_CANARY",
    "PRIVATE_503_CANARY",
    "PRIVATE_HEADER_CANARY",
    "PRIVATE_MISSING_TRACE_CANARY",
  ])
    assert(raw.includes(marker));
  assert(raw.includes(errors[0].stack));
});

test("Plan uses the supplied shared budget and never fabricates uncollected Trace or Run identities", async (t) => {
  const f = fixture(t);
  const diagnostics = createTraceDiagnostics({
    directory: f.directory,
    budgetMs: 0,
  });
  let calls = 0;
  const result = await collect("http://jaeger", f.inventory, {
    directory: f.directory,
    diagnostics,
    budgetMs: 60000,
    collectRequest: async () => {
      calls++;
      throw new Error("must not collect");
    },
  });
  assert.equal(calls, 0);
  for (const [index, expected] of all(f.inventory).entries())
    placeholder(result.checked[index], expected.label, index, "not_collected");
  assert.deepEqual(result.trace_diagnostics, diagnostics.summary());
  assert(
    result.trace_diagnostics.checks.every(
      (row) =>
        row.status === "not_collected" &&
        row.reason === "diagnostic-budget-exhausted",
    ),
  );
  assert.equal(result.strict.exit_code, 1);
});

test("Plan retains the original strict exit 2 and reports a warning after complete diagnostic collection", async (t) => {
  const f = fixture(t);
  const rows = (name, length, method) =>
    Array.from({ length }, (_, index) => ({
      label: `${name}-${index}`,
      method,
    }));
  const inventory = {
    setupRequests: rows("setup", 2, "session/new"),
    executionRequests: rows("execution", 12, "session/prompt"),
    replayRequests: rows("replay", 26, "session/load"),
    initializationRequests: rows("initialize", 14, "initialize"),
    runtimeInspection: {
      runtimes: [
        { agent_id: "agent-v1", generation: 7 },
        { agent_id: "agent-v2", generation: 8 },
      ],
    },
  };
  for (const [index, row] of inventory.replayRequests.slice(0, 6).entries())
    row.denial = index < 2 ? "access_denied" : "session_access_denied";
  const reports = new Map(
    all(inventory).map((expected, index) => {
      const execution = inventory.executionRequests.indexOf(expected);
      return [
        expected,
        {
          trace_id: (index + 1).toString(16).padStart(32, "0"),
          ...(expected.denial === undefined ? {} : { denial: expected.denial }),
          ...(execution < 0
            ? {}
            : {
                run_id: `run-${execution}`,
                runtime_tool_calls: execution % 6 === 1 ? 1 : 0,
                agent_id: execution < 6 ? "agent-v1" : "agent-v2",
                runtime_generation: execution < 6 ? "7" : "8",
              }),
          diagnostic_inventory_verified: true,
          raw_error_inventory: [],
          owned_error_spans: [],
          error_spans: 0,
          warning_count: index === 0 ? 1 : 0,
          warnings:
            index === 0
              ? [
                  "clock skew adjustment disabled; not applying calculated delta of 2ms",
                ]
              : [],
          strict_trace: index === 0 ? "failed" : "passed",
        },
      ];
    }),
  );
  // These are injected collector reports, never independent business receipts.
  const result = await collect("http://jaeger", inventory, {
    directory: f.directory,
    requests: inventory.executionRequests.map((row) => ({
      trace_id: reports.get(row).trace_id,
    })),
    collectRequest: async (_base, expected) => reports.get(expected),
  });
  assert.deepEqual(result.checked, [...reports.values()]);
  assert.equal(check(result, "plan-trace-inventory").status, "passed");
  assert.deepEqual(result.strict, {
    strict_trace: "failed",
    accepted: true,
    exit_code: 2,
    reviewed_error_spans: 0,
    clock_warnings_accepted: true,
  });
  assert.equal(check(result, "plan-strict-trace-result").status, "failed");
  assert.equal(result.trace_diagnostics.status, "warning");
});

for (const mode of ["budget", "parent"]) {
  test(
    `Plan ${mode} cancellation aborts actual HTTP and joins before any later request`,
    { timeout: 10000 },
    async (t) => {
      const f = fixture(t),
        controller = new AbortController();
      const requested = deferred(),
        remoteClosed = deferred(),
        aborted = deferred(),
        release = deferred();
      const reason = new Error("Plan suite interrupted");
      let requests = 0,
        joined = false,
        settled = false,
        pending,
        primary;
      const server = createServer((_request, response) => {
        requests++;
        response.on("close", () => remoteClosed.resolve());
        response.writeHead(200, {
          "Content-Type": "application/json",
          Connection: "close",
        });
        response.write('{"held":');
        requested.resolve();
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const diagnostics = createTraceDiagnostics({
        directory: f.directory,
        signal: controller.signal,
        budgetMs: mode === "budget" ? 1000 : 5000,
      });
      const calls = [];
      try {
        pending = collect(
          `http://127.0.0.1:${server.address().port}`,
          f.inventory,
          {
            directory: f.directory,
            signal: controller.signal,
            diagnostics,
            collectRequest: async (base, expected, options) => {
              calls.push(expected);
              assert(options.signal instanceof AbortSignal);
              try {
                const response = await fetch(`${base}/held`, {
                  signal: options.signal,
                });
                await response.text();
                assert.fail("held HTTP unexpectedly completed");
              } finally {
                assert.equal(options.signal.aborted, true);
                aborted.resolve(options.signal.reason);
                await release.promise;
                joined = true;
              }
            },
          },
        ).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error) => {
            settled = true;
            return { error };
          },
        );
        assert.equal(
          await Promise.race([
            requested.promise.then(() => true),
            pending.then(() => false),
          ]),
          true,
        );
        if (mode === "parent") controller.abort(reason);
        assert.equal(
          await Promise.race([
            aborted.promise.then(() => true),
            pending.then(() => false),
          ]),
          true,
        );
        await remoteClosed.promise;
        await immediate();
        assert.equal(settled, false, "collector cleanup must be joined");
        assert.equal(joined, false);
        release.resolve();
        const outcome = await pending;
        assert.equal(joined, true);
        assert.equal(requests, 1);
        assert.deepEqual(calls, [f.inventory.setupRequests[0]]);
        if (mode === "parent") assert.strictEqual(outcome.error, reason);
        else {
          assert.equal(outcome.error, undefined);
          placeholder(
            outcome.value.checked[0],
            all(f.inventory)[0].label,
            0,
            "unavailable",
          );
          for (let index = 1; index < 4; index++)
            placeholder(
              outcome.value.checked[index],
              all(f.inventory)[index].label,
              index,
              "not_collected",
            );
          assert.equal(outcome.value.trace_diagnostics.status, "warning");
        }
      } catch (error) {
        primary = error;
      } finally {
        controller.abort(reason);
        release.resolve();
        await pending;
        server.closeAllConnections();
        try {
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        } catch (error) {
          primary = primary
            ? new AggregateError(
                [primary, error],
                "Plan test and HTTP cleanup failed",
              )
            : error;
        }
      }
      if (primary) throw primary;
    },
  );
}

for (const mode of ["business", "cleanup", "business and cleanup"]) {
  test(`Plan diagnostic failure cannot swallow original ${mode} errors`, async (t) => {
    const f = fixture(t),
      business = new Error("Plan business failed"),
      cleanup = new Error("Plan close failed");
    const failBusiness = mode.includes("business"),
      failCleanup = mode.includes("cleanup"),
      calls = [];
    const clients = new Set([
      {
        async closeAndWait() {
          calls.push("close-first");
          if (failCleanup) throw cleanup;
        },
      },
      {
        async closeAndWait() {
          calls.push("close-second");
        },
      },
    ]);
    const diagnostics = createTraceDiagnostics({ directory: f.directory });
    await assert.rejects(
      withPrivateCommandResources(
        clients,
        {
          async shutdown() {
            calls.push("shutdown");
          },
        },
        async () => {
          const result = await collect("http://jaeger", f.inventory, {
            directory: f.directory,
            diagnostics,
            collectRequest: async () => {
              calls.push("diagnostic");
              throw new Error("Trace unavailable");
            },
          });
          assert.equal(result.trace_diagnostics.status, "warning");
          calls.push("business");
          if (failBusiness) throw business;
          return "original action result";
        },
        { traceDiagnostics: diagnostics, directory: f.directory },
      ),
      (error) => {
        if (failBusiness && failCleanup) {
          assert(error instanceof AggregateError);
          assert.deepEqual(error.errors, [business, cleanup]);
        } else assert.strictEqual(error, failBusiness ? business : cleanup);
        return true;
      },
    );
    assert.deepEqual(calls, [
      "diagnostic",
      "diagnostic",
      "diagnostic",
      "diagnostic",
      "business",
      "close-first",
      "close-second",
      "shutdown",
    ]);
    assert.equal(clients.size, 0);
  });
}
