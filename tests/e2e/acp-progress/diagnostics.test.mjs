import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { withPrivateCommandResources } from "../acp-commands/connection.mjs";

const url = new URL("./diagnostics.mjs", import.meta.url);
const { collectProgressTraceDiagnostics } = await import(url).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
    return {};
  throw error;
});

function fixture(t) {
  assert.equal(
    typeof collectProgressTraceDiagnostics,
    "function",
    "collectProgressTraceDiagnostics is not implemented",
  );
  const directory = mkdtempSync(
    join(tmpdir(), "antnest-progress-diagnostics-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    inventory: {
      requests: [
        { label: "new", kind: "request" },
        { label: "prompt", kind: "execution" },
      ],
      initializations: [{ label: "initialize", kind: "request" }],
      notifications: [
        { phase: "cancel-first", receipt: { id: "first" } },
        { phase: "cancel-second", receipt: { id: "second" } },
      ],
    },
    models: [{ trace_id: "prompt" }],
  };
}

function check(result, name) {
  const matches = result.trace_diagnostics.checks.filter(
    (row) => row.name === name,
  );
  assert.equal(matches.length, 1, `one ${name} diagnostic required`);
  return matches[0];
}

function failedPosition(row, label, name, status = "failed") {
  assert.deepEqual(Object.keys(row).sort(), ["diagnostic", "label"]);
  assert.equal(row.label, label);
  assert.equal(row.diagnostic.name, name);
  assert.equal(row.diagnostic.status, status);
  assert.equal(Object.hasOwn(row, "trace_id"), false);
  assert.equal(Object.hasOwn(row, "run_id"), false);
}

const names = [
  "progress-request-0",
  "progress-request-1",
  "progress-request-2",
  "progress-notification-0",
  "progress-notification-1",
  "progress-trace-inventory",
  "progress-strict-trace-result",
];

test("Progress Trace collection preserves failed positions and continues requests, initialization and notifications", async (t) => {
  const { directory, inventory, models } = fixture(t);
  const calls = [];
  const prompt = { trace_id: "prompt", run_id: "run" };
  const initialization = { trace_id: "initialize" };
  const notification = { trace_id: "cancel-second" };
  const result = await collectProgressTraceDiagnostics(
    "http://jaeger:16686",
    inventory,
    {
      directory,
      requests: models,
      collectRequest: async (base, expected, options) => {
        assert.equal(base, "http://jaeger:16686");
        assert(options.signal instanceof AbortSignal);
        assert.strictEqual(options.requests, models);
        calls.push(expected.label);
        if (expected.label === "new")
          throw new Error("request collection failed");
        return expected.label === "prompt" ? prompt : initialization;
      },
      collectNotification: async (base, receipt, options) => {
        assert.equal(base, "http://jaeger:16686");
        assert(options.signal instanceof AbortSignal);
        assert.strictEqual(options.requests, models);
        calls.push(`notification:${receipt.id}`);
        if (receipt === inventory.notifications[0].receipt)
          throw new Error("notification collection failed");
        assert.strictEqual(receipt, inventory.notifications[1].receipt);
        return notification;
      },
    },
  );
  assert.deepEqual(calls, [
    "new",
    "prompt",
    "initialize",
    "notification:first",
    "notification:second",
  ]);
  assert.equal(result.checked.length, 5);
  failedPosition(result.checked[0], "new", "progress-request-0");
  assert.strictEqual(result.checked[1], prompt);
  assert.strictEqual(result.checked[2], initialization);
  failedPosition(result.checked[3], "cancel-first", "progress-notification-0");
  assert.strictEqual(result.checked[4], notification);
  assert.deepEqual(
    result.trace_diagnostics.checks.map((row) => row.name),
    names,
  );
  assert.deepEqual(
    result.trace_diagnostics.checks.slice(0, 5).map((row) => row.status),
    ["failed", "passed", "passed", "failed", "passed"],
  );
  assert.equal(result.trace_diagnostics.role, "auxiliary");
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.strict.strict_trace, "failed");
  assert.equal(result.strict.accepted, false);
  assert.equal(check(result, "progress-strict-trace-result").status, "failed");
});

test("zero Progress diagnostic budget invokes no collector and retains every inventory position", async (t) => {
  const { directory, inventory, models } = fixture(t);
  let calls = 0;
  const collect = async () => {
    calls++;
    throw new Error("zero-budget collector must not run");
  };
  const result = await collectProgressTraceDiagnostics(
    "http://jaeger:16686",
    inventory,
    {
      directory,
      requests: models,
      budgetMs: 0,
      collectRequest: collect,
      collectNotification: collect,
    },
  );
  assert.equal(calls, 0);
  const labels = [
    "new",
    "prompt",
    "initialize",
    "cancel-first",
    "cancel-second",
  ];
  assert.equal(result.checked.length, labels.length);
  for (const [index, label] of labels.entries())
    failedPosition(result.checked[index], label, names[index], "not_collected");
  assert.deepEqual(
    result.trace_diagnostics.checks.map((row) => row.name),
    names,
  );
  for (const diagnostic of result.trace_diagnostics.checks) {
    assert.equal(diagnostic.status, "not_collected");
    assert.equal(diagnostic.reason, "diagnostic-budget-exhausted");
  }
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.strict.strict_trace, "failed");
  assert.equal(result.strict.accepted, false);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "parent Progress cancellation joins the collector before throwing the original reason",
  { timeout: 10000 },
  async (t) => {
    const { directory, inventory, models } = fixture(t);
    const controller = new AbortController();
    const reason = new Error("Progress suite interrupted");
    const entered = deferred(),
      aborted = deferred(),
      release = deferred();
    let collectorSignal,
      joined = false,
      settled = false;
    const calls = [];
    const pending = collectProgressTraceDiagnostics(
      "http://jaeger:16686",
      inventory,
      {
        directory,
        requests: models,
        signal: controller.signal,
        budgetMs: 5000,
        collectRequest: async (_base, expected, options) => {
          calls.push(expected.label);
          collectorSignal = options.signal;
          assert(collectorSignal instanceof AbortSignal);
          const onAbort = () => aborted.resolve();
          collectorSignal.addEventListener("abort", onAbort, { once: true });
          if (collectorSignal.aborted) aborted.resolve();
          entered.resolve();
          try {
            await aborted.promise;
            await release.promise;
            return { trace_id: "late-success" };
          } finally {
            collectorSignal.removeEventListener("abort", onAbort);
            joined = true;
          }
        },
        collectNotification: async () => {
          calls.push("notification");
          throw new Error("cancelled inventory must not continue");
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
    try {
      assert.equal(
        await Promise.race([
          entered.promise.then(() => true),
          pending.then(() => false),
        ]),
        true,
      );
      controller.abort(reason);
      assert.equal(collectorSignal.aborted, true);
      assert.strictEqual(collectorSignal.reason, reason);
      assert.equal(
        await Promise.race([
          aborted.promise.then(() => true),
          pending.then(() => false),
        ]),
        true,
      );
      await immediate();
      assert.equal(joined, false);
      assert.equal(
        settled,
        false,
        "cancellation must wait for collector cleanup",
      );
      release.resolve();
      const outcome = await pending;
      assert.strictEqual(outcome.error, reason);
      assert.equal(joined, true);
      assert.deepEqual(calls, ["new"]);
    } finally {
      controller.abort(reason);
      release.resolve();
      await pending;
    }
  },
);

function completeInventory() {
  return {
    requests: Array.from({ length: 44 }, (_, index) => ({
      label: `request-${index}`,
      kind: index < 12 ? "execution" : "request",
    })),
    initializations: Array.from({ length: 28 }, (_, index) => ({
      label: `initialize-${index}`,
      kind: "request",
    })),
    notifications: Array.from({ length: 4 }, (_, index) => ({
      phase: `cancel-${index}`,
      receipt: { id: `cancel-${index}` },
    })),
  };
}

for (const defect of ["missing Run", "duplicate Trace"]) {
  test(`successful Progress collection with ${defect} remains a failed auxiliary inventory check`, async (t) => {
    const { directory } = fixture(t);
    const inventory = completeInventory();
    const models = inventory.requests
      .slice(0, 12)
      .map((row) => ({ trace_id: `trace-${row.label}` }));
    const collect = (broken) =>
      collectProgressTraceDiagnostics("http://jaeger:16686", inventory, {
        directory,
        requests: models,
        collectRequest: async (_base, expected) => {
          const report = {
            trace_id: `trace-${expected.label}`,
            ...(expected.kind === "execution"
              ? { run_id: `run-${expected.label}` }
              : {}),
          };
          if (
            broken &&
            defect === "missing Run" &&
            expected.label === "request-0"
          )
            delete report.run_id;
          if (
            broken &&
            defect === "duplicate Trace" &&
            expected.label === "initialize-1"
          )
            report.trace_id = "trace-initialize-0";
          return report;
        },
        collectNotification: async (_base, receipt) => ({
          trace_id: `trace-${receipt.id}`,
        }),
      });
    // These are collector return values, not fabricated Span or admission receipts.
    const control = await collect(false);
    assert.equal(control.checked.length, 76);
    assert.equal(check(control, "progress-trace-inventory").status, "passed");
    const result = await collect(true);
    assert.equal(result.checked.length, 76);
    assert(
      result.checked.every(
        (row) => row.trace_id && !Object.hasOwn(row, "diagnostic"),
      ),
    );
    assert(
      result.trace_diagnostics.checks
        .slice(0, 76)
        .every((row) => row.status === "passed"),
    );
    assert.equal(check(result, "progress-trace-inventory").status, "failed");
    assert.equal(result.trace_diagnostics.status, "warning");
    assert.equal(result.strict.strict_trace, "failed");
    assert.equal(result.strict.accepted, false);
    assert.equal(
      check(result, "progress-strict-trace-result").status,
      "failed",
    );
  });
}

for (const mode of ["business", "cleanup", "business and cleanup"]) {
  test(`unavailable Progress Traces cannot suppress a later ${mode} failure`, async (t) => {
    const { directory, inventory, models } = fixture(t);
    const business = new Error("Progress Runtime business failed");
    const cleanup = new Error("Progress connection cleanup failed");
    const failBusiness = mode.includes("business"),
      failCleanup = mode.includes("cleanup");
    const calls = [];
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
    const telemetry = {
      async shutdown() {
        calls.push("telemetry");
      },
    };
    let diagnostics;
    const collect = async () => {
      calls.push("trace-unavailable");
      throw new Error("Jaeger unavailable");
    };
    await assert.rejects(
      withPrivateCommandResources(clients, telemetry, async () => {
        diagnostics = await collectProgressTraceDiagnostics(
          "http://jaeger:16686",
          inventory,
          {
            directory,
            requests: models,
            collectRequest: collect,
            collectNotification: collect,
          },
        );
        assert.equal(diagnostics.trace_diagnostics.status, "warning");
        calls.push("business");
        if (failBusiness) throw business;
        return "business complete";
      }),
      (error) => {
        if (failBusiness && failCleanup) {
          assert(error instanceof AggregateError);
          assert.deepEqual(error.errors, [business, cleanup]);
        } else assert.strictEqual(error, failBusiness ? business : cleanup);
        return true;
      },
    );
    assert.equal(diagnostics.checked.length, 5);
    assert(
      diagnostics.checked.every((row) => row.diagnostic.status === "failed"),
    );
    assert.equal(diagnostics.strict.strict_trace, "failed");
    assert.deepEqual(calls, [
      ...Array(5).fill("trace-unavailable"),
      "business",
      "close-first",
      "close-second",
      "telemetry",
    ]);
    assert.equal(clients.size, 0);
  });
}
