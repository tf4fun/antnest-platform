import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";

const implementationURL = new URL("./diagnostics.mjs", import.meta.url);
const { collectManagedDiagnostics } = await import(implementationURL).catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes(implementationURL.pathname)
    )
      throw error;
    return {};
  },
);

function fixture(t) {
  assert.equal(
    typeof collectManagedDiagnostics,
    "function",
    "collectManagedDiagnostics is not implemented",
  );
  const directory = mkdtempSync(join(tmpdir(), "antnest-managed-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lifecycle = ["create", "rebuild", "delete"].map((kind, index) => ({
    kind,
    agentId: "managed-agent",
    requestId: `lifecycle-${index}`,
  }));
  const requests = Array.from({ length: 14 }, (_, index) => ({
    label: index < 3 ? `initialize-${index}` : `request-${index - 3}`,
    method: index < 3 ? "initialize" : "session/prompt",
    requestId: String(index + 1),
  }));
  return { directory, lifecycle, requests };
}

const lifecycleLabel = (expected) => expected.label ?? expected.kind;
const checkNames = (f) => [
  ...f.lifecycle.map((_, index) => `managed-lifecycle-${index}`),
  ...f.requests.map((_, index) => `managed-request-${index}`),
  "managed-trace-inventory",
];
const rawReport = (label) => ({
  label,
  trace_id: `trace-${label}`,
  strict_trace: "passed",
  private_raw: "PRIVATE_RAW_REPORT_CANARY",
});

function check(result, name) {
  const matches = result.diagnostics.checks.filter((row) => row.name === name);
  assert.equal(matches.length, 1, "one owning diagnostic check required");
  return matches[0];
}

function placeholder(row, label, name, status = "failed") {
  assert.deepEqual(Object.keys(row).sort(), ["diagnostic", "label"]);
  assert.equal(row.label, label);
  assert.equal(row.diagnostic.name, name);
  assert.equal(row.diagnostic.status, status);
  assert(!Object.hasOwn(row, "trace_id"));
  assert(!Object.hasOwn(row, "run_id"));
  assert(!Object.hasOwn(row, "status"));
}

function safeSummary(summary) {
  assert.deepEqual(Object.keys(summary).sort(), [
    "checks",
    "evidence",
    "role",
    "status",
    "version",
  ]);
  assert.equal(summary.version, 1);
  assert.equal(summary.role, "auxiliary");
  for (const row of summary.checks) {
    assert(
      Object.keys(row).every((key) =>
        [
          "name",
          "status",
          "duration_ms",
          "reason",
          "error_type",
          "failure_evidence",
          "evidence_error_type",
        ].includes(key),
      ),
      "diagnostic summary exposed raw fields",
    );
  }
  assert(!JSON.stringify(summary).includes("PRIVATE_"));
  assert(!JSON.stringify(summary).includes("authorization"));
}

function privateErrors(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".private.txt"))
    .map((name) => {
      const path = join(directory, name);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      return readFileSync(path, "utf8");
    })
    .join("\n");
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Managed diagnostics test barrier timed out")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withCleanup(body, cleanup) {
  let value;
  const errors = [];
  try {
    value = await body();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Managed diagnostics test and cleanup failed",
    );
  return value;
}

test("Managed diagnostics retain actual callback values and the three plus fourteen diagnostic positions", async (t) => {
  const f = fixture(t);
  const calls = [];
  const lifecycleReports = f.lifecycle.map((row) => rawReport(row.kind));
  const sessionReports = f.requests.map((row) => rawReport(row.label));
  const inventory = { strict_trace: "passed", diagnostic_requests: 14 };
  const result = await collectManagedDiagnostics(f, {
    async collectLifecycle(expected, signal) {
      assert(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      assert(f.lifecycle.includes(expected));
      calls.push(`lifecycle:${expected.kind}`);
      return lifecycleReports[f.lifecycle.indexOf(expected)];
    },
    async collectRequest(expected, signal) {
      assert(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      assert(f.requests.includes(expected));
      calls.push(`request:${expected.label}`);
      return sessionReports[f.requests.indexOf(expected)];
    },
    async inspectInventory(actual) {
      calls.push("inventory");
      assert.deepEqual(Object.keys(actual).sort(), [
        "lifecycleReports",
        "sessionReports",
      ]);
      assert.deepEqual(actual.lifecycleReports, lifecycleReports);
      assert.deepEqual(actual.sessionReports, sessionReports);
      return inventory;
    },
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "diagnostics",
    "inventory",
    "lifecycleReports",
    "sessionReports",
  ]);
  assert.deepEqual(calls, [
    ...f.lifecycle.map((row) => `lifecycle:${row.kind}`),
    ...f.requests.map((row) => `request:${row.label}`),
    "inventory",
  ]);
  for (const [index, value] of lifecycleReports.entries())
    assert.strictEqual(result.lifecycleReports[index], value);
  for (const [index, value] of sessionReports.entries())
    assert.strictEqual(result.sessionReports[index], value);
  assert.strictEqual(result.inventory, inventory);
  assert.equal(result.diagnostics.status, "passed");
  assert.deepEqual(
    result.diagnostics.checks.map((row) => row.name),
    checkNames(f),
  );
  assert(result.diagnostics.checks.every((row) => row.status === "passed"));
  safeSummary(result.diagnostics);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(f.directory, result.diagnostics.evidence), "utf8"),
    ),
    result.diagnostics,
  );
});

test("no Trace exports leave placeholders, continue every diagnostic and never invent an inventory", async (t) => {
  const f = fixture(t);
  const calls = [];
  const missing = new Error("PRIVATE_MISSING_TRACE_CANARY");
  const result = await collectManagedDiagnostics(f, {
    async collectLifecycle(expected) {
      calls.push(expected.kind);
      throw missing;
    },
    async collectRequest(expected) {
      calls.push(expected.label);
      throw missing;
    },
    async inspectInventory({ lifecycleReports, sessionReports }) {
      calls.push("inventory");
      assert.equal(lifecycleReports.length, 3);
      assert.equal(sessionReports.length, 14);
      assert.fail("PRIVATE_INCOMPLETE_INVENTORY_CANARY");
    },
  });
  assert.deepEqual(calls, [
    ...f.lifecycle.map((row) => row.kind),
    ...f.requests.map((row) => row.label),
    "inventory",
  ]);
  for (const [index, row] of f.lifecycle.entries())
    placeholder(
      result.lifecycleReports[index],
      lifecycleLabel(row),
      `managed-lifecycle-${index}`,
    );
  for (const [index, row] of f.requests.entries())
    placeholder(
      result.sessionReports[index],
      row.label,
      `managed-request-${index}`,
    );
  assert.equal(result.inventory, null);
  assert.equal(result.diagnostics.status, "warning");
  assert.equal(check(result, "managed-trace-inventory").status, "failed");
  safeSummary(result.diagnostics);
  assert.match(privateErrors(f.directory), /PRIVATE_MISSING_TRACE_CANARY/u);
});

test("collector 503 and owning inspector errors stay private while later lifecycle and requests continue", async (t) => {
  const f = fixture(t);
  const calls = [];
  const unavailable = Object.assign(
    new Error("PRIVATE_COLLECTOR_503_CANARY", {
      cause: {
        status: 503,
        body: "PRIVATE_RESPONSE_BODY_CANARY",
        authorization: "PRIVATE_HEADER_CANARY",
      },
    }),
    { code: "PRIVATE_RESPONSE_CODE_CANARY" },
  );
  const inspectFailure = new Error("PRIVATE_OWNING_INSPECTOR_CANARY");
  const result = await collectManagedDiagnostics(f, {
    async collectLifecycle(expected) {
      calls.push(expected.kind);
      if (expected === f.lifecycle[0]) throw unavailable;
      return rawReport(expected.kind);
    },
    async collectRequest(expected) {
      calls.push(expected.label);
      if (expected === f.requests[0]) throw inspectFailure;
      return rawReport(expected.label);
    },
    async inspectInventory({ lifecycleReports, sessionReports }) {
      calls.push("inventory");
      assert.equal(lifecycleReports[0].diagnostic.status, "failed");
      assert.equal(sessionReports[0].diagnostic.status, "failed");
      throw new Error("PRIVATE_RAW_INVENTORY_FAILURE_CANARY");
    },
  });
  assert.deepEqual(calls, [
    ...f.lifecycle.map((row) => row.kind),
    ...f.requests.map((row) => row.label),
    "inventory",
  ]);
  placeholder(result.lifecycleReports[0], "create", "managed-lifecycle-0");
  placeholder(result.sessionReports[0], "initialize-0", "managed-request-0");
  assert.equal(result.lifecycleReports[1].trace_id, "trace-rebuild");
  assert.equal(result.sessionReports.at(-1).trace_id, "trace-request-10");
  assert.equal(result.inventory, null);
  safeSummary(result.diagnostics);
  const raw = privateErrors(f.directory);
  for (const canary of [
    "PRIVATE_COLLECTOR_503_CANARY",
    "PRIVATE_RESPONSE_BODY_CANARY",
    "PRIVATE_HEADER_CANARY",
    "PRIVATE_OWNING_INSPECTOR_CANARY",
    "PRIVATE_RAW_INVENTORY_FAILURE_CANARY",
  ])
    assert(raw.includes(canary), "original private failure details were lost");
  assert(raw.includes(unavailable.stack));
});

test("a failed final inventory preserves all successful collection values as diagnostics", async (t) => {
  const f = fixture(t);
  const result = await collectManagedDiagnostics(f, {
    async collectLifecycle(expected) {
      return rawReport(expected.kind);
    },
    async collectRequest(expected) {
      return rawReport(expected.label);
    },
    async inspectInventory({ lifecycleReports, sessionReports }) {
      assert.equal(lifecycleReports.length, 3);
      assert.equal(sessionReports.length, 14);
      throw new Error("PRIVATE_STRICT_TOPOLOGY_FAILURE_CANARY");
    },
  });
  assert(
    result.lifecycleReports.every((row) => row.trace_id && !row.diagnostic),
  );
  assert(result.sessionReports.every((row) => row.trace_id && !row.diagnostic));
  assert(
    result.diagnostics.checks
      .slice(0, 17)
      .every((row) => row.status === "passed"),
  );
  assert.equal(check(result, "managed-trace-inventory").status, "failed");
  assert.equal(result.inventory, null);
  assert.equal(result.diagnostics.status, "warning");
  assert.match(
    privateErrors(f.directory),
    /PRIVATE_STRICT_TOPOLOGY_FAILURE_CANARY/u,
  );
  safeSummary(result.diagnostics);
});

test("an observability archive failure warns and does not suppress the following diagnostics", async (t) => {
  const f = fixture(t);
  const calls = [];
  const result = await collectManagedDiagnostics(f, {
    async collectLifecycle(expected) {
      calls.push(expected.kind);
      if (expected === f.lifecycle[0]) {
        rmSync(f.directory, { recursive: true });
        writeFileSync(f.directory, "PRIVATE_ARCHIVE_BLOCKER_CANARY", {
          mode: 0o600,
        });
      } else if (expected === f.lifecycle[1]) {
        rmSync(f.directory);
        mkdirSync(f.directory, { mode: 0o700 });
      }
      return rawReport(expected.kind);
    },
    async collectRequest(expected) {
      calls.push(expected.label);
      return rawReport(expected.label);
    },
    async inspectInventory() {
      calls.push("inventory");
      return { status: "checked" };
    },
  });
  assert.deepEqual(calls, [
    ...f.lifecycle.map((row) => row.kind),
    ...f.requests.map((row) => row.label),
    "inventory",
  ]);
  const first = check(result, "managed-lifecycle-0");
  assert.equal(
    first.status,
    "passed",
    "the collector itself returned actual data",
  );
  assert.equal(typeof first.evidence_error_type, "string");
  assert.equal(result.diagnostics.status, "warning");
  assert.equal(check(result, "managed-request-13").status, "passed");
  assert.equal(check(result, "managed-trace-inventory").status, "passed");
  safeSummary(result.diagnostics);
});

test("zero total budget invokes neither collector nor inventory inspector and preserves every skipped position", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const unexpected = async () => {
    calls++;
    throw new Error("zero budget callback");
  };
  const result = await collectManagedDiagnostics(
    { ...f, budgetMs: 0 },
    {
      collectLifecycle: unexpected,
      collectRequest: unexpected,
      inspectInventory: unexpected,
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.inventory, null);
  for (const [index, row] of f.lifecycle.entries())
    placeholder(
      result.lifecycleReports[index],
      lifecycleLabel(row),
      `managed-lifecycle-${index}`,
      "not_collected",
    );
  for (const [index, row] of f.requests.entries())
    placeholder(
      result.sessionReports[index],
      row.label,
      `managed-request-${index}`,
      "not_collected",
    );
  assert.deepEqual(
    result.diagnostics.checks.map((row) => row.name),
    checkNames(f),
  );
  assert(
    result.diagnostics.checks.every(
      (row) =>
        row.status === "not_collected" &&
        row.reason === "diagnostic-budget-exhausted",
    ),
  );
  assert.equal(result.diagnostics.status, "warning");
  safeSummary(result.diagnostics);
});

test(
  "one shared budget aborts and joins the active collector before skipping all later callbacks",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    const abortObserved = Promise.withResolvers();
    const release = Promise.withResolvers();
    const calls = [];
    let joined = false;
    let settled = false;
    const task = collectManagedDiagnostics(
      { ...f, budgetMs: 20 },
      {
        async collectLifecycle(expected, signal) {
          calls.push(expected.kind);
          const onAbort = () => abortObserved.resolve(signal);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          try {
            await abortObserved.promise;
            await release.promise;
            return rawReport("late-collector-success");
          } finally {
            signal.removeEventListener("abort", onAbort);
            joined = true;
          }
        },
        async collectRequest(expected) {
          calls.push(expected.label);
          return rawReport(expected.label);
        },
        async inspectInventory() {
          calls.push("inventory");
          return { status: "checked" };
        },
      },
    );
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await withCleanup(
      async () => {
        const signal = await within(abortObserved.promise);
        assert(signal instanceof AbortSignal);
        assert.equal(signal.aborted, true);
        await immediate();
        assert.equal(joined, false);
        assert.equal(
          settled,
          false,
          "deadline abandoned active collector cleanup",
        );
        assert.deepEqual(calls, ["create"]);
        release.resolve();
        const result = await within(task);
        assert.equal(joined, true);
        assert.deepEqual(calls, ["create"]);
        placeholder(
          result.lifecycleReports[0],
          "create",
          "managed-lifecycle-0",
          "unavailable",
        );
        assert.equal(result.inventory, null);
        assert(
          result.diagnostics.checks
            .slice(1)
            .every((row) => row.status === "not_collected"),
        );
        assert.equal(result.diagnostics.status, "warning");
        safeSummary(result.diagnostics);
      },
      async () => {
        release.resolve();
        await within(Promise.allSettled([task]));
      },
    );
  },
);

test("an already aborted parent starts no diagnostics and throws its original reason", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error("PRIVATE_PREABORT_CANARY");
  controller.abort(reason);
  let calls = 0;
  const unexpected = async () => {
    calls++;
    throw new Error("callback after parent abort");
  };
  await assert.rejects(
    collectManagedDiagnostics(
      { ...f, signal: controller.signal },
      {
        collectLifecycle: unexpected,
        collectRequest: unexpected,
        inspectInventory: unexpected,
      },
    ),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
});

for (const stage of ["lifecycle", "request", "inventory"])
  test(
    `parent cancellation during ${stage} waits for actual join and throws the original Error`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t);
      const controller = new AbortController();
      const reason = new Error(`PRIVATE_PARENT_${stage.toUpperCase()}_CANARY`);
      const entered = Promise.withResolvers();
      const abortObserved = Promise.withResolvers();
      const release = Promise.withResolvers();
      const calls = [];
      let joined = false;
      let settled = false;
      async function held(signal) {
        const onAbort = () => abortObserved.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        entered.resolve(signal);
        try {
          await abortObserved.promise;
          await release.promise;
          return rawReport("late-parent-cancelled-success");
        } finally {
          signal.removeEventListener("abort", onAbort);
          joined = true;
        }
      }
      const task = collectManagedDiagnostics(
        { ...f, signal: controller.signal },
        {
          async collectLifecycle(expected, signal) {
            calls.push(`lifecycle:${expected.kind}`);
            return stage === "lifecycle"
              ? held(signal)
              : rawReport(expected.kind);
          },
          async collectRequest(expected, signal) {
            calls.push(`request:${expected.label}`);
            return stage === "request"
              ? held(signal)
              : rawReport(expected.label);
          },
          async inspectInventory() {
            calls.push("inventory");
            return held(controller.signal);
          },
        },
      );
      void task.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await withCleanup(
        async () => {
          const signal = await within(entered.promise);
          controller.abort(reason);
          assert.equal(signal.aborted, true);
          assert.strictEqual(signal.reason, reason);
          await within(abortObserved.promise);
          const callsAtAbort = [...calls];
          await immediate();
          assert.equal(joined, false);
          assert.equal(
            settled,
            false,
            "parent interruption abandoned its callback",
          );
          release.resolve();
          await assert.rejects(within(task), (error) => error === reason);
          assert.equal(joined, true);
          assert.deepEqual(
            calls,
            callsAtAbort,
            "diagnostics continued after parent interruption",
          );
        },
        async () => {
          controller.abort(reason);
          release.resolve();
          await within(Promise.allSettled([task]));
        },
      );
    },
  );
