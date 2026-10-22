import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { pullCiImages } from "./ci-pull-images.mjs";
import { temporaryStorageRoot } from "./storage.mjs";

const collector = "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0";
const postgres = "postgres:17.11-bookworm";
const node = "node:24.21.0-bookworm-slim";

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(predicate, message) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert(performance.now() < deadline, message);
    await delay(1);
  }
}

async function withFixture(run) {
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-ci-pull-images-"),
  );
  const parent = new AbortController();
  const gates = [];
  const operations = [];
  const pulls = [];
  const fixture = {
    directory,
    parent,
    gate() {
      const gate = deferred();
      gates.push(gate);
      return gate;
    },
    pull(callback) {
      return (image, signal) => {
        const promise = Promise.resolve().then(() => callback(image, signal));
        pulls.push(Promise.allSettled([promise]));
        return promise;
      };
    },
    operation(callback) {
      const operation = { settled: false };
      operation.promise = Promise.resolve().then(callback);
      operation.outcome = operation.promise.then(
        (value) => {
          operation.settled = true;
          return { status: "fulfilled", value };
        },
        (reason) => {
          operation.settled = true;
          return { status: "rejected", reason };
        },
      );
      operations.push(operation.outcome);
      return operation;
    },
  };
  try {
    return await run(fixture);
  } finally {
    parent.abort(new Error("CI image pull fixture cleanup"));
    for (const gate of gates) gate.release();
    await Promise.allSettled(operations);
    await Promise.allSettled(pulls);
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertPrivateWarning(directory, trace, messages) {
  assert.equal(trace.version, 1);
  assert.equal(trace.role, "auxiliary");
  assert.equal(trace.status, "warning");
  assert.equal(trace.checks.length, 1);
  const row = trace.checks[0];
  assert(row.failure_evidence?.endsWith(".private.txt"));
  assert(readdirSync(directory).includes(trace.evidence));
  const saved = JSON.parse(
    readFileSync(join(directory, trace.evidence), "utf8"),
  );
  assert.deepEqual(saved, trace);
  const rawPath = join(directory, row.failure_evidence);
  const raw = readFileSync(rawPath, "utf8");
  for (const message of messages) {
    assert(
      raw.includes(message),
      "the original private failure was not retained",
    );
    assert(
      !JSON.stringify(trace).includes(message),
      "public diagnostics exposed a private failure",
    );
  }
  assert.equal(statSync(rawPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, trace.evidence)).mode & 0o777, 0o600);
}

test("CI pulls await each required image in order before auxiliary collection and business", async () => {
  await withFixture(async (f) => {
    const required = Object.freeze([postgres, node]);
    const auxiliary = Object.freeze([collector]);
    const before = structuredClone({ required, auxiliary });
    const first = f.gate();
    const second = f.gate();
    const steps = [];
    const operation = f.operation(async () => {
      const result = await pullCiImages({
        required,
        auxiliary,
        directory: f.directory,
        signal: f.parent.signal,
        pullImage: f.pull(async (image) => {
          steps.push(`start:${image}`);
          if (image === postgres) await first.promise;
          if (image === node) await second.promise;
          steps.push(`end:${image}`);
        }),
      });
      steps.push("business");
      return result;
    });
    await until(
      () => steps.length > 0 || operation.settled,
      "first required image did not start",
    );
    assert.deepEqual(steps, [`start:${postgres}`]);
    first.release();
    await until(
      () => steps.includes(`start:${node}`) || operation.settled,
      "second required image did not start",
    );
    assert.deepEqual(steps, [
      `start:${postgres}`,
      `end:${postgres}`,
      `start:${node}`,
    ]);
    second.release();
    const result = await operation.promise;
    assert.deepEqual(steps, [
      `start:${postgres}`,
      `end:${postgres}`,
      `start:${node}`,
      `end:${node}`,
      `start:${collector}`,
      `end:${collector}`,
      "business",
    ]);
    assert.equal(result.required, 2);
    assert.equal(result.trace.status, "passed");
    assert.equal(result.trace.checks.length, 1);
    assert.deepEqual({ required, auxiliary }, before);
  });
});

test("a required image failure propagates unchanged and starts no later pull or business", async () => {
  await withFixture(async (f) => {
    const original = new Error("required image pull failed");
    const called = [];
    let business = false;
    const operation = f.operation(async () => {
      await pullCiImages({
        required: [postgres, node, "temporalio/admin-tools:1.32.0"],
        auxiliary: [collector],
        directory: f.directory,
        signal: f.parent.signal,
        pullImage: f.pull(async (image) => {
          called.push(image);
          if (image === node) throw original;
        }),
      });
      business = true;
    });
    await assert.rejects(operation.promise, (error) => error === original);
    assert.deepEqual(called, [postgres, node]);
    assert.equal(business, false);
  });
});

test("a Jaeger pull failure preserves private diagnostics and permits downstream business", async () => {
  await withFixture(async (f) => {
    const messages = [
      "fixture-private-registry-response",
      "fixture-private-registry-cause",
    ];
    const original = new Error(messages[0], { cause: { body: messages[1] } });
    const steps = [];
    const operation = f.operation(async () => {
      const result = await pullCiImages({
        required: [postgres],
        auxiliary: [collector],
        directory: f.directory,
        signal: f.parent.signal,
        pullImage: f.pull(async (image) => {
          steps.push(image);
          if (image === collector) throw original;
        }),
      });
      steps.push("business-authorization", "business-cleanup");
      return result;
    });
    const result = await operation.promise;
    assert.deepEqual(steps, [
      postgres,
      collector,
      "business-authorization",
      "business-cleanup",
    ]);
    assert.equal(result.required, 1);
    assert.equal(result.trace.checks[0].status, "failed");
    assertPrivateWarning(f.directory, result.trace, messages);
  });
});

test("empty image inventories run no pull and return not_run Trace diagnostics", async () => {
  await withFixture(async (f) => {
    let calls = 0;
    const operation = f.operation(() =>
      pullCiImages({
        required: Object.freeze([]),
        auxiliary: Object.freeze([]),
        directory: f.directory,
        pullImage: f.pull(async () => {
          calls++;
        }),
      }),
    );
    const result = await operation.promise;
    assert.equal(calls, 0);
    assert.equal(result.required, 0);
    assert.equal(result.trace.role, "auxiliary");
    assert.equal(result.trace.status, "not_run");
    assert.deepEqual(result.trace.checks, []);
  });
});

test("required-only image pulls remain blocking with not_run auxiliary diagnostics", async () => {
  await withFixture(async (f) => {
    const called = [];
    const operation = f.operation(() =>
      pullCiImages({
        required: [postgres, node],
        auxiliary: [],
        directory: f.directory,
        signal: f.parent.signal,
        pullImage: f.pull(async (image) => {
          called.push(image);
        }),
      }),
    );
    const result = await operation.promise;
    assert.deepEqual(called, [postgres, node]);
    assert.equal(result.required, 2);
    assert.equal(result.trace.status, "not_run");
    assert.deepEqual(result.trace.checks, []);
  });
});

for (const image of [
  postgres,
  node,
  "temporalio/admin-tools:1.32.0",
  "cr.jaegertracing.io/jaegertracing/jaeger:2.21.1",
  "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0-other",
  `cr.jaegertracing.io/jaegertracing/jaeger@sha256:${"a".repeat(64)}`,
  "other.registry/jaegertracing/jaeger:2.21.0",
]) {
  test(`auxiliary pull ownership rejects the noncanonical image ${image} before any pull`, async () => {
    await withFixture(async (f) => {
      const required = Object.freeze(["registry.example/required:1"]);
      const auxiliary = Object.freeze([collector, image]);
      let calls = 0;
      let business = false;
      const operation = f.operation(async () => {
        await pullCiImages({
          required,
          auxiliary,
          directory: f.directory,
          signal: f.parent.signal,
          pullImage: f.pull(async () => {
            calls++;
          }),
        });
        business = true;
      });
      await assert.rejects(operation.promise);
      assert.equal(
        calls,
        0,
        "inventories must be validated before required pulling",
      );
      assert.equal(business, false);
      assert.deepEqual(required, ["registry.example/required:1"]);
      assert.deepEqual(auxiliary, [collector, image]);
    });
  });
}

for (const [name, required, auxiliary] of [
  ["duplicate required", [postgres, postgres], []],
  ["duplicate auxiliary", [postgres], [collector, collector]],
  ["overlapping ownership", [collector], [collector]],
  ["non-array required", postgres, []],
  ["non-array auxiliary", [postgres], collector],
  ["non-string required", [postgres, 17], []],
  ["non-string auxiliary", [postgres], [collector, null]],
  ["empty required image", [postgres, ""], []],
  ["empty auxiliary image", [postgres], [collector, ""]],
]) {
  test(`invalid image inventory rejects ${name} before execution without mutation`, async () => {
    await withFixture(async (f) => {
      const before = structuredClone({ required, auxiliary });
      if (Array.isArray(required)) Object.freeze(required);
      if (Array.isArray(auxiliary)) Object.freeze(auxiliary);
      let calls = 0;
      const operation = f.operation(() =>
        pullCiImages({
          required,
          auxiliary,
          directory: f.directory,
          signal: f.parent.signal,
          pullImage: f.pull(async () => {
            calls++;
          }),
        }),
      );
      await assert.rejects(operation.promise);
      assert.equal(calls, 0);
      assert.deepEqual({ required, auxiliary }, before);
    });
  });
}

test("an auxiliary deadline aborts its signal but cannot continue business before the actual pull joins", async () => {
  await withFixture(async (f) => {
    const release = f.gate();
    let localSignal;
    let abortObserved = false;
    let joined = false;
    let business = false;
    const operation = f.operation(async () => {
      const result = await pullCiImages({
        required: [postgres],
        auxiliary: [collector],
        directory: f.directory,
        signal: f.parent.signal,
        budgetMs: 20,
        pullImage: f.pull(async (image, signal) => {
          if (image !== collector) return;
          localSignal = signal;
          const observe = () => {
            abortObserved = true;
          };
          signal.addEventListener("abort", observe, { once: true });
          if (signal.aborted) observe();
          try {
            await release.promise;
          } finally {
            signal.removeEventListener("abort", observe);
            joined = true;
          }
        }),
      });
      business = true;
      return result;
    });
    await until(
      () => abortObserved || operation.settled,
      "auxiliary budget did not abort the actual pull signal",
    );
    assert(localSignal instanceof AbortSignal);
    assert.equal(localSignal.aborted, true);
    assert.equal(abortObserved, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      operation.settled,
      false,
      "timeout detached a still-running pull",
    );
    assert.equal(joined, false);
    assert.equal(business, false);
    release.release();
    const result = await operation.promise;
    assert.equal(joined, true);
    assert.equal(business, true);
    assert.equal(result.required, 1);
    assert.equal(result.trace.status, "warning");
    assert.equal(result.trace.checks[0].status, "unavailable");
    assertPrivateWarning(f.directory, result.trace, []);
  });
});

test("parent cancellation waits for the held auxiliary pull to join and never starts business", async () => {
  await withFixture(async (f) => {
    const release = f.gate();
    const reason = new Error("fixture-parent-pull-cancelled");
    let localSignal;
    let joined = false;
    let business = false;
    const operation = f.operation(async () => {
      const result = await pullCiImages({
        required: [postgres],
        auxiliary: [collector],
        directory: f.directory,
        signal: f.parent.signal,
        budgetMs: 1000,
        pullImage: f.pull(async (image, signal) => {
          if (image !== collector) return;
          localSignal = signal;
          try {
            await release.promise;
          } finally {
            joined = true;
          }
        }),
      });
      business = true;
      return result;
    });
    await until(
      () => localSignal !== undefined || operation.settled,
      "held auxiliary pull did not start",
    );
    assert(localSignal instanceof AbortSignal);
    f.parent.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(localSignal.aborted, true);
    assert.equal(
      operation.settled,
      false,
      "parent cancellation detached the actual pull promise",
    );
    assert.equal(joined, false);
    assert.equal(business, false);
    release.release();
    await assert.rejects(operation.promise, (error) => error === reason);
    assert.equal(joined, true);
    assert.equal(business, false);
  });
});

test("a pre-cancelled parent starts no required or auxiliary pull", async () => {
  await withFixture(async (f) => {
    const reason = new Error("fixture-parent-already-cancelled");
    f.parent.abort(reason);
    let calls = 0;
    let business = false;
    const operation = f.operation(async () => {
      await pullCiImages({
        required: [postgres],
        auxiliary: [collector],
        directory: f.directory,
        signal: f.parent.signal,
        pullImage: f.pull(async () => {
          calls++;
        }),
      });
      business = true;
    });
    await assert.rejects(operation.promise, (error) => error === reason);
    assert.equal(calls, 0);
    assert.equal(business, false);
  });
});
