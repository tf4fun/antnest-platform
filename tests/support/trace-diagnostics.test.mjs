import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createTraceDiagnostics } from "./trace-diagnostics.mjs";

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-trace-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    diagnostics: createTraceDiagnostics({ directory, ...options }),
  };
}

test("successful auxiliary inspection preserves its actual result", async (t) => {
  const { diagnostics } = fixture(t);
  const value = { trace_id: "original", spans: 4 };
  const result = await diagnostics.run("request", async () => value);
  assert.equal(result.status, "passed");
  assert.strictEqual(result.value, value);
  assert.equal(diagnostics.summary().status, "passed");
});

test("a Trace failure remains visible and does not prevent later business or diagnostics", async (t) => {
  const { diagnostics } = fixture(t);
  const steps = [];
  const failed = await diagnostics.run("missing-parent", async () => {
    throw new Error("missing parent");
  });
  assert.equal(failed.status, "failed");
  assert.equal(Object.hasOwn(failed, "value"), false);
  steps.push("model-check", "browser-check");
  await diagnostics.run("next-run", async () => steps.push("next-run"));
  steps.push("resource-cleanup");
  assert.deepEqual(steps, [
    "model-check",
    "browser-check",
    "next-run",
    "resource-cleanup",
  ]);
  assert.deepEqual(
    diagnostics.summary().checks.map((row) => row.status),
    ["failed", "passed"],
  );
  assert.equal(diagnostics.summary().status, "warning");
});

test("raw errors are private while public diagnostics exclude messages and causes", async (t) => {
  const { diagnostics, directory } = fixture(t);
  const error = new Error("private-response-secret", {
    cause: { body: "raw-response-secret" },
  });
  await diagnostics.run("detail-http", async () => {
    throw error;
  });
  const summary = diagnostics.summary();
  assert(!JSON.stringify(summary).includes("secret"));
  const files = readdirSync(directory);
  const failure = files.find((name) => name.endsWith(".private.txt"));
  assert(failure);
  assert.match(
    readFileSync(join(directory, failure), "utf8"),
    /private-response-secret/u,
  );
  assert.match(
    readFileSync(join(directory, failure), "utf8"),
    /raw-response-secret/u,
  );
  assert.equal(statSync(join(directory, failure)).mode & 0o777, 0o600);
});

test("diagnostic deadline aborts the collector and joins its cleanup before continuing", async (t) => {
  const { diagnostics } = fixture(t, { budgetMs: 20 });
  let cleaned = false;
  const result = await diagnostics.run("unavailable", async (signal) => {
    try {
      await delay(60_000, undefined, { signal });
    } finally {
      await delay(1);
      cleaned = true;
    }
  });
  assert.equal(cleaned, true);
  assert.equal(result.status, "unavailable");
  let invoked = false;
  const skipped = await diagnostics.run("over-budget", async () => {
    invoked = true;
  });
  assert.equal(invoked, false);
  assert.equal(skipped.status, "not_collected");
  assert.equal(diagnostics.summary().status, "warning");
});

test("a late successful response cannot become a passed deadline result", async (t) => {
  const { diagnostics } = fixture(t, { budgetMs: 10 });
  const result = await diagnostics.run("late", async (signal) => {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    return { complete_parents: true };
  });
  assert.equal(result.status, "unavailable");
  assert.equal(Object.hasOwn(result, "value"), false);
});

test("whole-suite cancellation remains fatal and is joined", async (t) => {
  const controller = new AbortController();
  const reason = new Error("suite interrupted");
  const { diagnostics } = fixture(t, { signal: controller.signal });
  let joined = false;
  const pending = diagnostics.run("collect", async (signal) => {
    try {
      controller.abort(reason);
      await delay(60_000, undefined, { signal });
    } finally {
      joined = true;
    }
  });
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(joined, true);
});

for (const gate of [
  "authorization",
  "model-pending",
  "runtime-ack",
  "resource-cleanup",
]) {
  test(`${gate} failure after a failed Trace is still fatal`, async (t) => {
    const { diagnostics } = fixture(t);
    const failure = new Error(gate);
    await assert.rejects(
      async () => {
        await diagnostics.run("trace", async () => {
          throw new Error("Jaeger HTTP failure");
        });
        throw failure;
      },
      (error) => error === failure,
    );
    assert.equal(diagnostics.summary().status, "warning");
  });
}
