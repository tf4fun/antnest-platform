import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  measureResolveLoad,
  verifyResolveLoad,
} from "./resolve-cache-flow.mjs";
import { inspectLoadWire } from "./resolve-cache-load.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";

const originalFetch = globalThis.fetch;
const outputs = new Set();
globalThis.fetch = async () => {
  throw new Error("unexpected external HTTP in orchestration test");
};
test.after(() => {
  globalThis.fetch = originalFetch;
  for (const output of outputs)
    rmSync(output, { recursive: true, force: true });
});
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

function earlyWakeFixture() {
  let time = 0,
    requests = 0;
  const wire = {},
    waits = [],
    controller = new AbortController();
  return {
    wire,
    waits,
    controller,
    options: {
      gateway: "https://gateway.invalid",
      agentID: "agent",
      cookie: "session=private-token",
      wire,
      signal: controller.signal,
      now: () => time,
      wait: async (ms, _value, { signal }) => {
        assert.equal(signal.aborted, false);
        waits.push(ms);
        time += waits.length <= 2 ? Math.max(0, ms - 2) : ms;
      },
      request: async () => {
        time++;
        requests++;
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-antnest-trace-id": requests.toString(16).padStart(32, "0"),
          },
        });
      },
    },
  };
}

test("load measurement waits through repeated early timer wakeups", async () => {
  const f = earlyWakeFixture();
  await measureResolveLoad(f.options);
  assert.equal(f.waits.length, 3);
  assert.equal(f.wire.requests.length, 100);
  assert(
    f.wire.requests.at(-1).started_at - f.wire.requests[0].completed_at >= 5000,
  );
  assert(f.wire.completed_at - f.wire.started_at <= 8000);
});

test("load measurement stops after an early wakeup is cancelled", async () => {
  const f = earlyWakeFixture(),
    wait = f.options.wait;
  f.options.wait = async (...args) => {
    await wait(...args);
    f.controller.abort(new Error("private cancellation detail"));
  };
  await assert.rejects(measureResolveLoad(f.options), (error) => {
    assert.match(error.message, /Bridge load (?:delay )?cancelled/u);
    assert(!error.message.includes("private cancellation detail"));
    return true;
  });
  assert.equal(f.waits.length, 1);
  assert.equal(f.wire.requests.length, 99);
  assert(Number.isFinite(f.wire.completed_at));
});

function fixture() {
  let time = 10,
    requests = 0,
    releaseBody,
    ownerDiagnostics;
  const finalHeaders = deferred(),
    restoring = deferred(),
    finishRestore = deferred();
  const events = [],
    written = [],
    receipt = { restored: false };
  const controls = {
    holdBody: false,
    holdRestore: false,
    restore: true,
    traceHeaders: true,
    restoreError: undefined,
    principal: {
      organization_id: "actual-login-org",
      user_id: "actual-owner",
      organization_slug: "stage3",
      organization_role: "member",
      active: true,
    },
  };
  const output = mkdtempSync(
    join(temporaryStorageRoot(), "resolve-cache-load-flow-"),
  );
  outputs.add(output);
  const input = {
    config: {
      gateway: "https://gateway.invalid",
      jaeger: "http://jaeger.invalid",
      project: "owned-project",
      env: { SELECTED: "fixture-environment" },
    },
    fixture: { agentID: "agent", ownerID: "actual-owner" },
    settings: { resolveTTLMS: 10000, captureRpcContent: false },
    output,
    docker: () => {},
    compose: () => {},
    images: { "agent-ui": "selected-image" },
  };
  const dependencies = {
    createClient(gateway) {
      assert.equal(gateway, input.config.gateway);
      return {
        cookie: "session=private-token",
        cookies: new Map(),
        async request(path) {
          assert.equal(path, "/api/session/login");
          events.push("login");
          return { body: { principal: controls.principal } };
        },
      };
    },
    async createOwner(options) {
      events.push("baseline");
      assert.equal(requests, 0, "owner baseline must precede first request");
      for (const key of ["docker", "compose", "images", "output"])
        assert.equal(options[key], input[key]);
      assert.equal(options.project, input.config.project);
      assert.equal(options.environment, input.config.env);
      assert.equal(options.agentID, input.fixture.agentID);
      assert.equal(typeof options.diagnostics?.run, "function");
      assert.equal(typeof options.diagnostics?.summary, "function");
      ownerDiagnostics = options.diagnostics;
      return {
        async collect(wire, collect) {
          assert.equal(
            inspectLoadWire(wire, { requireTrace: false }).length,
            100,
          );
          events.push("stop");
          try {
            return await collect(receipt);
          } finally {
            events.push("restore-start");
            restoring.resolve();
            if (controls.holdRestore) await finishRestore.promise;
            receipt.restored = controls.restore;
            events.push("restore-complete");
            if (controls.restoreError) throw controls.restoreError;
          }
        },
      };
    },
    measure(options) {
      return measureResolveLoad({
        ...options,
        now: () => ++time,
        wait: async (ms) => {
          time += ms;
        },
        request: async () => {
          requests++;
          const body = JSON.stringify({ items: [], nextCursor: null });
          let payload = body;
          if (requests === 100 && controls.holdBody) {
            payload = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                releaseBody = () => controller.close();
              },
            });
            finalHeaders.resolve();
          }
          return new Response(payload, {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              ...(controls.traceHeaders
                ? {
                    "x-antnest-trace-id": requests
                      .toString(16)
                      .padStart(32, "0"),
                  }
                : {}),
            },
          });
        },
      });
    },
    async collect(base, wire, agent, settings, secrets, options) {
      events.push("collect");
      assert.equal(requests, 100);
      assert.equal(base, input.config.jaeger);
      assert.equal(agent, input.fixture.agentID);
      assert.equal(settings, input.settings);
      assert.equal(options.ownerLifecycle, receipt);
      assert(options.signal instanceof AbortSignal);
      assert.notEqual(options.signal, input.signal);
      assert.deepEqual(options.ownerScope, {
        organization_id: "actual-login-org",
        user_id: "actual-owner",
        agent_id: "agent",
      });
      assert.equal(receipt.restored, false, "collect before restoration");
      assert(secrets.includes("session=private-token"));
      return {
        owner_cleanup: { owner_scope: options.ownerScope },
        background_refreshes: 1,
        strict_trace: "failed",
        error_spans: 2,
      };
    },
    business({ wire, ownerLifecycle, ownerScope }) {
      assert.equal(ownerLifecycle, receipt);
      assert.equal(receipt.restored, true, "business follows restoration");
      assert.equal(inspectLoadWire(wire, { requireTrace: false }).length, 100);
      assert.deepEqual(ownerScope, {
        organization_id: "actual-login-org",
        user_id: "actual-owner",
        agent_id: "agent",
      });
      const measurement = structuredClone(wire);
      for (const row of measurement.requests) delete row.body;
      return {
        schema: "resolve-cache-load-business/v1",
        status: "passed",
        owner_scope: ownerScope,
        exchanges: 100,
        elapsed_ms: wire.completed_at - wire.started_at,
        measurement,
        owner_lifecycle: ownerLifecycle,
      };
    },
    admit(completed) {
      assert.equal(completed.schema, "resolve-cache-load-business/v1");
      assert.equal(completed.status, "passed");
      assert.equal(completed.owner_lifecycle.restored, true);
      assert.equal(completed.exchanges, 100);
      assert.equal(completed.measurement.requests.length, 100);
      assert.deepEqual(completed.owner_scope, {
        organization_id: "actual-login-org",
        user_id: "actual-owner",
        agent_id: "agent",
      });
      events.push("admit");
    },
    admitTrace(completed) {
      assert.equal(
        receipt.restored,
        true,
        "Trace admission follows restoration",
      );
      assert.equal(completed.owner_lifecycle, receipt);
    },
    write(directory, name, data) {
      written.push({ directory, name, value: JSON.parse(data) });
    },
  };
  return {
    input,
    dependencies,
    controls,
    events,
    written,
    receipt,
    finalHeaders,
    restoring,
    get diagnostics() {
      return ownerDiagnostics;
    },
    release: () => {
      const close = releaseBody;
      releaseBody = undefined;
      close?.();
    },
    resume: () => finishRestore.resolve(),
  };
}

test("load flow waits for the final response body and for restoration", async () => {
  const f = fixture();
  f.controls.holdBody = f.controls.holdRestore = true;
  let settled = false;
  const running = verifyResolveLoad(f.input, f.dependencies).finally(() => {
    settled = true;
  });
  void running.catch(() => {});
  try {
    await Promise.race([f.finalHeaders.promise, running]);
    assert.deepEqual(f.events, ["login", "baseline"]);
    assert.equal(settled, false);
    f.release();
    await Promise.race([f.restoring.promise, running]);
    assert.equal(settled, false);
    f.resume();
    const result = await running;
    assert.equal(result.owner_lifecycle, f.receipt);
    assert.equal(result.owner_lifecycle.restored, true);
    assert.equal(
      result.observability.strict_trace,
      "failed",
      "raw errors must remain strict failures",
    );
    assert.equal(result.schema, "resolve-cache-load-business/v1");
    assert.equal(result.status, "passed");
    assert.equal(result.trace_diagnostics.version, 1);
    assert.equal(result.trace_diagnostics.role, "auxiliary");
    for (const name of ["load-collection", "load-trace-admission"])
      assert(result.trace_diagnostics.checks.some((row) => row.name === name));
    assert.deepEqual(f.events, [
      "login",
      "baseline",
      "stop",
      "collect",
      "restore-start",
      "restore-complete",
      "admit",
    ]);
    const saved = f.written.find((row) => row.name === "load-completed.json");
    assert.equal(saved.value.owner_lifecycle.restored, true);
  } finally {
    f.release();
    f.resume();
    await running.catch(() => {});
  }
});

test("load flow retains collection failure as a warning after owner restoration and business admission", async () => {
  const f = fixture(),
    failure = new Error("trace closure missing");
  f.dependencies.collect = async () => {
    f.events.push("collect");
    throw failure;
  };
  const result = await verifyResolveLoad(f.input, f.dependencies);
  assert.equal(f.receipt.restored, true);
  assert.equal(result.status, "passed");
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.observability.diagnostic.status, "failed");
  assert.equal(
    result.trace_diagnostics.checks.find(
      (row) => row.name === "load-collection",
    ).status,
    "failed",
  );
  assert.deepEqual(f.events, [
    "login",
    "baseline",
    "stop",
    "collect",
    "restore-start",
    "restore-complete",
    "admit",
  ]);
  assert(f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow preserves a restoration failure when Trace collection also fails", async () => {
  const f = fixture();
  const traceFailure = new Error("Trace source unavailable");
  const restorationFailure = new Error("actual owner restoration failed");
  f.dependencies.collect = async () => {
    throw traceFailure;
  };
  f.controls.restoreError = restorationFailure;
  await assert.rejects(
    verifyResolveLoad(f.input, f.dependencies),
    (error) => error === restorationFailure,
  );
  assert.equal(f.diagnostics.summary().status, "warning");
  assert.equal(
    f.diagnostics.summary().checks.find((row) => row.name === "load-collection")
      .status,
    "failed",
  );
  assert(f.events.includes("restore-complete"));
  assert(!f.events.includes("admit"));
  assert(!f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow measures complete HTTP responses without response Trace IDs", async () => {
  const f = fixture();
  f.controls.traceHeaders = false;
  const result = await verifyResolveLoad(f.input, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.exchanges, 100);
  assert.equal(result.measurement.requests.length, 100);
  assert(result.measurement.requests.every((row) => !row.trace_id));
  assert(result.measurement.requests.every((row) => row.body_complete));
  assert(result.elapsed_ms <= 8000);
  assert.equal(f.receipt.restored, true);
  assert(f.events.includes("admit"));
});

test("load flow preserves measurement and wire archive failures together", async () => {
  const f = fixture(),
    measurement = new Error("response body failed"),
    archive = new Error("wire archive failed");
  f.dependencies.measure = async ({ wire }) => {
    wire.requests = [];
    throw measurement;
  };
  f.dependencies.write = () => {
    throw archive;
  };
  await assert.rejects(
    verifyResolveLoad(f.input, f.dependencies),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(measurement) &&
      error.errors.includes(archive),
  );
  assert.deepEqual(f.events, ["login", "baseline"]);
});

test("load flow archives failed measurement without beginning drain", async () => {
  const f = fixture(),
    failure = new Error("incomplete measured response");
  f.dependencies.measure = async ({ wire }) => {
    wire.requests = [{ body_complete: false }];
    throw failure;
  };
  await assert.rejects(
    verifyResolveLoad(f.input, f.dependencies),
    (error) => error === failure,
  );
  assert.equal(f.written[0].name, "load-wire.private.json");
  assert.deepEqual(f.events, ["login", "baseline"]);
});

test("load flow rejects incomplete owner restoration", async () => {
  const f = fixture();
  f.controls.restore = false;
  await assert.rejects(
    verifyResolveLoad(f.input, f.dependencies),
    (error) =>
      error.code === "ERR_ASSERTION" &&
      error.actual === false &&
      error.expected === true &&
      error.message.split("\n")[0] === "load owner restoration incomplete",
  );
  assert(!f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow reports final archive failure after restoration", async () => {
  const f = fixture(),
    failure = new Error("final archive failed"),
    write = f.dependencies.write;
  f.dependencies.write = (...args) => {
    if (args[1] === "load-completed.json") throw failure;
    return write(...args);
  };
  await assert.rejects(
    verifyResolveLoad(f.input, f.dependencies),
    (error) => error === failure,
  );
  assert.equal(f.receipt.restored, true);
});

test("load flow admission failure prevents completion archive after restoration", async () => {
  const f = fixture(),
    failure = new Error("aggregate evidence incomplete");
  f.dependencies.admit = () => {
    throw failure;
  };
  await assert.rejects(
    verifyResolveLoad(f.input, f.dependencies),
    (error) => error === failure,
  );
  assert.equal(f.receipt.restored, true);
  assert(!f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow default business admission rejects incomplete owner receipts", async () => {
  const f = fixture();
  delete f.dependencies.admit;
  await assert.rejects(verifyResolveLoad(f.input, f.dependencies));
  assert.equal(f.receipt.restored, true);
  assert(!f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow retains a foreign collector owner as a warning while business stays bound to the actual login", async () => {
  const f = fixture(),
    collect = f.dependencies.collect;
  f.dependencies.collect = async (...args) => {
    const result = await collect(...args);
    result.owner_cleanup.owner_scope = {
      ...result.owner_cleanup.owner_scope,
      user_id: "foreign-owner",
    };
    return result;
  };
  const result = await verifyResolveLoad(f.input, f.dependencies);
  assert.equal(f.receipt.restored, true);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.owner_scope, {
    organization_id: "actual-login-org",
    user_id: "actual-owner",
    agent_id: "agent",
  });
  assert.equal(
    result.observability.owner_cleanup.owner_scope.user_id,
    "foreign-owner",
  );
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(
    result.trace_diagnostics.checks.find(
      (row) => row.name === "load-trace-admission",
    ).status,
    "failed",
  );
  assert(f.events.includes("admit"));
  assert(f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow keeps Trace admission failure auxiliary after business admission", async () => {
  const f = fixture();
  f.dependencies.admitTrace = () => {
    throw new Error("raw Trace topology incomplete");
  };
  const result = await verifyResolveLoad(f.input, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.observability.strict_trace, "failed");
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(
    result.trace_diagnostics.checks.find(
      (row) => row.name === "load-trace-admission",
    ).status,
    "failed",
  );
  assert.equal(f.receipt.restored, true);
  assert(f.events.includes("admit"));
  assert(f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow does not turn an unwitnessed background refresh into a business failure", async () => {
  const f = fixture();
  const collect = f.dependencies.collect;
  f.dependencies.collect = async (...args) => ({
    ...(await collect(...args)),
    background_refreshes: 0,
  });
  const result = await verifyResolveLoad(f.input, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.observability.background_refreshes, 0);
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(f.receipt.restored, true);
  assert(f.events.includes("admit"));
});

test("load flow does not downgrade business receipt construction failure", async () => {
  const f = fixture();
  const failure = new Error("actual owner business receipt incomplete");
  f.dependencies.business = () => {
    throw failure;
  };
  await assert.rejects(
    verifyResolveLoad(f.input, f.dependencies),
    (error) => error === failure,
  );
  assert.equal(f.receipt.restored, true);
  assert(!f.events.includes("admit"));
  assert(!f.written.some((row) => row.name === "load-completed.json"));
});

test("load flow rejects a business receipt missing its owning lifecycle", async () => {
  const f = fixture();
  const business = f.dependencies.business;
  f.dependencies.business = (...args) => {
    const value = business(...args);
    delete value.owner_lifecycle;
    return value;
  };
  await assert.rejects(verifyResolveLoad(f.input, f.dependencies));
  assert.equal(f.receipt.restored, true);
  assert(!f.events.includes("admit"));
  assert(!f.written.some((row) => row.name === "load-completed.json"));
});

for (const [field, value] of [
  ["organization_id", ""],
  ["user_id", "another-owner"],
  ["organization_slug", "another-org"],
  ["organization_role", "admin"],
  ["active", false],
])
  test(`load flow rejects invalid authenticated ${field} before measurements`, async () => {
    const f = fixture();
    f.controls.principal[field] = value;
    await assert.rejects(
      verifyResolveLoad(f.input, f.dependencies),
      /load login/u,
    );
    assert.deepEqual(f.events, ["login"]);
  });
