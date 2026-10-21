import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

const url = new URL("./access-diagnostics.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const collect = (...args) => {
  assert.equal(typeof implementation.collectAccessDiagnostics, "function");
  return implementation.collectAccessDiagnostics(...args);
};
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "access-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    diagnostics: createTraceDiagnostics({ directory, ...options }),
  };
}

test("Access diagnostics continue after collectors fail and never turn strict findings into admission", async (t) => {
  const f = await fixture(t),
    calls = [];
  const original = new Error("private collector failure");
  const result = await collect(
    { diagnostics: f.diagnostics, requests: [1, 2] },
    {
      collectRequest: async (row, signal) => {
        assert(signal instanceof AbortSignal);
        calls.push(row);
        if (row === 1) throw original;
        return { strict_trace: "failed", label: "second" };
      },
      collectManagement: async () => {
        calls.push("management");
        throw original;
      },
      collectClosures: async () => {
        calls.push("closures");
        return [{ strict_trace: "passed" }];
      },
      inspect: ({ reports }) => {
        calls.push("strict");
        assert.equal(reports[0].diagnostic.status, "failed");
        assert.equal(reports[1].strict_trace, "failed");
        throw new Error("strict trace findings");
      },
    },
  );
  assert.deepEqual(calls, ["management", 1, 2, "closures", "strict"]);
  assert.equal(result.trace_diagnostics.role, "auxiliary");
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.reports.length, 2);
  assert.equal(result.management, null);
  assert.equal(result.closures.length, 1);
});

test("Access exhausted diagnostic budget keeps explicit missing results without running collectors", async (t) => {
  const f = await fixture(t, { budgetMs: 0 });
  const forbidden = () => assert.fail("collector after exhausted budget");
  const result = await collect(
    { diagnostics: f.diagnostics, requests: [1, 2] },
    {
      collectRequest: forbidden,
      collectManagement: forbidden,
      collectClosures: forbidden,
      inspect: forbidden,
    },
  );
  assert.equal(result.reports.length, 2);
  assert(
    result.reports.every((row) => row.diagnostic.status === "not_collected"),
  );
  assert.equal(result.management, null);
  assert.equal(result.closures, null);
  assert.equal(result.trace_diagnostics.status, "warning");
});

for (const parentAbort of [false, true])
  test(`Access ${parentAbort ? "parent cancellation" : "diagnostic expiry"} joins the held collector`, async (t) => {
    const parent = new AbortController();
    const f = await fixture(t, {
      signal: parent.signal,
      budgetMs: parentAbort ? 1000 : 10,
    });
    const entered = Promise.withResolvers(),
      aborted = Promise.withResolvers(),
      release = Promise.withResolvers();
    let finished = false,
      joined = false;
    const failure = new Error("ownership cancelled");
    const operation = collect(
      { diagnostics: f.diagnostics, requests: [1] },
      {
        async collectManagement(signal) {
          entered.resolve();
          await new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true },
            ),
          );
          try {
            signal.throwIfAborted();
          } finally {
            await release.promise;
            joined = true;
          }
        },
        collectRequest: () => assert.fail("expired collector dispatched"),
        collectClosures: () => assert.fail("expired collector dispatched"),
        inspect: () => assert.fail("expired collector dispatched"),
      },
    )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        finished = true;
      });
    try {
      await entered.promise;
      if (parentAbort) parent.abort(failure);
      await aborted.promise;
      await delay(1);
      assert.equal(finished, false);
    } finally {
      release.resolve();
    }
    const outcome = await operation;
    assert.equal(joined, true);
    if (parentAbort) assert.equal(outcome.error, failure);
    else assert.equal(outcome.value.trace_diagnostics.status, "warning");
  });

test("Access exporter shutdown is always joined and its original failure retained even after budget exhaustion", async (t) => {
  const f = await fixture(t, { budgetMs: 0 });
  assert.equal(typeof implementation.shutdownAccessTelemetry, "function");
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let finished = false;
  const error = new Error("original private exporter failure");
  const operation = implementation
    .shutdownAccessTelemetry(
      {
        async shutdown() {
          entered.resolve();
          await release.promise;
          throw error;
        },
      },
      f,
    )
    .finally(() => {
      finished = true;
    });
  await entered.promise;
  assert.equal(finished, false);
  release.resolve();
  await operation;
  const file = join(f.directory, "access-telemetry-shutdown.private.txt");
  assert.match(
    await readFile(file, "utf8"),
    /original private exporter failure/,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
