import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const url = new URL("./session-owner-drain.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const project = "antnest-stage3-e2e-1234";
const runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";

function lifecycle() {
  const start = Date.parse("2026-10-15T10:00:00Z");
  const baseline = Object.fromEntries(
    [
      "agent-ui",
      "edge-gateway",
      "identity-service",
      "agent-acp-service",
      "agent-controller",
      "runtime-controller",
      "jaeger",
      "runtime",
    ].map((service, index) => [
      service,
      {
        id: String(index + 1).repeat(64),
        project,
        service,
        image: "sha256:" + String(index + 1).repeat(64),
        configuration_sha256: "a".repeat(64),
        restart_count: 0,
        running: true,
        restarting: false,
        oom_killed: false,
        exit_code: 0,
        health: "healthy",
        started_at: new Date(start).toISOString(),
        finished_at: "0001-01-01T00:00:00Z",
        at: 10,
        observed_at_ms: start + 10,
      },
    ]),
  );
  const result = {
    project,
    agent_id: "agent",
    baseline,
    before: structuredClone(baseline),
    after: structuredClone(baseline),
    requested_at: 100,
    requested_at_ms: start + 100,
    stopped_at: 120,
    log_checked: true,
    forced_drain: false,
    log_sha256: "b".repeat(64),
    restored: false,
  };
  for (const state of Object.values(result.after)) {
    state.at = 130;
    state.observed_at_ms = start + 130;
  }
  result.after["agent-ui"].running = false;
  result.after["agent-ui"].finished_at = new Date(start + 115).toISOString();
  return result;
}
function restore(receipt) {
  const after = structuredClone(receipt.after);
  for (const state of Object.values(after)) {
    state.at = 155;
    state.observed_at_ms += 25;
  }
  after["agent-ui"].running = true;
  after["agent-ui"].started_at = "2026-10-15T10:00:00.150Z";
  receipt.restore = { requested_at: 140, completed_at: 160, after };
  receipt.restored = true;
}
function input() {
  return {
    agentId: "agent",
    clients: new Set(),
    observers: new Set(),
    modelRequests: 8,
    identityTransitions: [
      {
        deployment: {
          step: 3,
          after: {
            container_id: "3".repeat(64),
            started_at: "2026-10-15T10:00:00.000Z",
            token_ttl: "12h",
            running: true,
          },
        },
      },
    ],
    closures: [
      "revoked",
      "revoked",
      "unavailable",
      "unavailable",
      "expired",
      "expired",
      "revoked",
      "revoked",
    ].map((reason, index) => ({
      traceID: (index + 1).toString(16).repeat(32),
      reason,
      protocolVersion: (index % 2) + 1,
      transport: "http-sse",
      localClose: false,
      protocolClientClosedLocally: true,
      closure: { at: 0 },
      denial: { completedMono: 0 },
    })),
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "antnest-session-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [],
    receipt = lifecycle();
  const options = { directory, project, runID, timeoutMs: 3000 };
  const serve = (changes = {}) =>
    implementation.serveSessionOwnerDrain({
      ...options,
      async createLifecycle(request) {
        events.push("baseline");
        assert.equal(request.agent_id, "agent");
        return {
          baseline: receipt.baseline,
          async collect(callback) {
            events.push("stopped");
            try {
              return await callback(receipt);
            } finally {
              restore(receipt);
              events.push("restored");
            }
          },
        };
      },
      ...changes,
    });
  return { directory, events, receipt, options, serve };
}

test("Session collects only inside an acknowledged real owner stop and joins restoration", async (t) => {
  assert.equal(typeof implementation.withSessionOwnerDrain, "function");
  assert.equal(typeof implementation.serveSessionOwnerDrain, "function");
  const f = await fixture(t);
  const host = f.serve();
  const result = await implementation.withSessionOwnerDrain(
    input(),
    async (receipt) => {
      assert.deepEqual(f.events, ["baseline", "stopped"]);
      assert.equal(receipt.after["agent-ui"].running, false);
      f.events.push("collect-original-traces");
      return "original-trace-result";
    },
    f.options,
  );
  await host;
  assert.equal(result, "original-trace-result");
  assert.deepEqual(f.events, [
    "baseline",
    "stopped",
    "collect-original-traces",
    "restored",
  ]);
  const request = JSON.parse(
    await readFile(join(f.directory, "request-owner-drain"), "utf8"),
  );
  assert.equal(request.public_trace_ids.length, 8);
  assert.equal(request.identity_container_id, "3".repeat(64));
  const ack = JSON.parse(
    await readFile(join(f.directory, "owner-restored"), "utf8"),
  );
  assert.deepEqual(ack.request, request);
  assert.equal(ack.lifecycle.restored, true);
});

for (const metadata of ["missing", "duplicate"])
  test(`Session owner stop and restoration complete with ${metadata} original Trace IDs`, async (t) => {
    assert.equal(typeof implementation.withSessionOwnerDrain, "function");
    assert.equal(typeof implementation.serveSessionOwnerDrain, "function");
    const f = await fixture(t),
      value = input(),
      controller = new AbortController();
    if (metadata === "missing")
      for (const closure of value.closures) delete closure.traceID;
    else
      for (const closure of value.closures)
        closure.traceID = value.closures[0].traceID;
    const originalClosures = structuredClone(value.closures);
    const host = f.serve({ signal: controller.signal });
    const client = implementation
      .withSessionOwnerDrain(
        value,
        async (receipt) => {
          assert.deepEqual(f.events, ["baseline", "stopped"]);
          assert.equal(receipt.after["agent-ui"].running, false);
          f.events.push("collection-entered");
          return "collected-after-real-stop";
        },
        f.options,
      )
      .catch((error) => {
        // A preflight failure cannot leave the host polling for an unpublished
        // request. Once stop begins, the normal restoration handshake must join.
        if (!f.events.includes("stopped")) controller.abort(error);
        throw error;
      });
    const results = await Promise.allSettled([host, client]);
    assert.equal(results[0].status, "fulfilled", String(results[0].reason));
    assert.equal(results[1].status, "fulfilled", String(results[1].reason));
    assert.equal(results[1].value, "collected-after-real-stop");
    assert.deepEqual(f.events, [
      "baseline",
      "stopped",
      "collection-entered",
      "restored",
    ]);
    assert.equal(value.closures.length, 8);
    assert.deepEqual(value.closures, originalClosures);
    const request = JSON.parse(
      await readFile(join(f.directory, "request-owner-drain"), "utf8"),
    );
    assert.equal(request.agent_id, value.agentId);
    assert.equal(request.identity_container_id, "3".repeat(64));
    const ack = JSON.parse(
      await readFile(join(f.directory, "owner-restored"), "utf8"),
    );
    assert.deepEqual(ack.request, request);
    assert.equal(ack.status, "restored");
    assert.equal(ack.lifecycle.restored, true);
  });

for (const fault of ["forced-drain", "foreign-restoration"])
  test(`missing Trace IDs cannot excuse ${fault} after an actual owner stop`, async (t) => {
    const f = await fixture(t),
      value = input(),
      controller = new AbortController();
    for (const closure of value.closures) delete closure.traceID;
    let collected = false;
    const host = f.serve({
      signal: controller.signal,
      async createLifecycle(request) {
        f.events.push("baseline");
        return {
          baseline: f.receipt.baseline,
          async collect(callback) {
            f.events.push("stopped");
            if (fault === "forced-drain") f.receipt.forced_drain = true;
            try {
              return await callback(f.receipt);
            } finally {
              restore(f.receipt);
              f.events.push("restored");
              if (fault === "foreign-restoration")
                request.nonce = "00000000-0000-4000-8000-000000000000";
            }
          },
        };
      },
    });
    const client = implementation
      .withSessionOwnerDrain(
        value,
        async () => {
          collected = true;
          return "collected";
        },
        f.options,
      )
      .catch((error) => {
        if (!f.events.includes("stopped")) controller.abort(error);
        throw error;
      });
    const results = await Promise.allSettled([host, client]);
    assert.equal(results[1].status, "rejected");
    assert.deepEqual(f.events, ["baseline", "stopped", "restored"]);
    assert.equal(f.receipt.restored, true);
    if (fault === "forced-drain") {
      assert.equal(results[0].status, "rejected");
      assert.equal(collected, false);
    } else {
      assert.equal(results[0].status, "fulfilled");
      assert.equal(collected, true);
      const request = JSON.parse(
        await readFile(join(f.directory, "request-owner-drain"), "utf8"),
      );
      const ack = JSON.parse(
        await readFile(join(f.directory, "owner-restored"), "utf8"),
      );
      assert.notEqual(ack.request.nonce, request.nonce);
    }
  });

for (const [name, change] of [
  ["unfinished protocol client", (value) => value.clients.add({})],
  ["unfinished browser observer", (value) => value.observers.add({})],
  [
    "locally aborted public stream",
    (value) => {
      value.closures[0].localClose = true;
    },
  ],
  [
    "unjoined protocol client",
    (value) => {
      value.closures[0].protocolClientClosedLocally = false;
    },
  ],
  ["missing scenario", (value) => value.closures.pop()],
  [
    "unrestored Identity",
    (value) => {
      value.identityTransitions[0].deployment.step = 2;
    },
  ],
  [
    "incomplete model effects",
    (value) => {
      value.modelRequests = 7;
    },
  ],
])
  test(`Session rejects ${name} before requesting UI stop`, async (t) => {
    assert.equal(typeof implementation.withSessionOwnerDrain, "function");
    const f = await fixture(t),
      value = input();
    change(value);
    await assert.rejects(() =>
      implementation.withSessionOwnerDrain(
        value,
        () => assert.fail("collection admitted"),
        f.options,
      ),
    );
    await assert.rejects(readFile(join(f.directory, "request-owner-drain")), {
      code: "ENOENT",
    });
  });

test("a stale drained acknowledgement cannot admit original trace collection", async (t) => {
  assert.equal(typeof implementation.withSessionOwnerDrain, "function");
  const f = await fixture(t);
  await writeFile(join(f.directory, "owner-drained"), "{}\n");
  await assert.rejects(() =>
    implementation.withSessionOwnerDrain(
      input(),
      () => assert.fail("stale acknowledgement"),
      f.options,
    ),
  );
  await assert.rejects(readFile(join(f.directory, "request-owner-drain")), {
    code: "ENOENT",
  });
});

test("trace rejection still joins the original UI restoration and retains the rejection", async (t) => {
  assert.equal(typeof implementation.withSessionOwnerDrain, "function");
  const f = await fixture(t),
    failure = new Error("original missing parent");
  const host = f.serve();
  await assert.rejects(
    () =>
      implementation.withSessionOwnerDrain(
        input(),
        async () => {
          throw failure;
        },
        f.options,
      ),
    (error) => error === failure,
  );
  await host;
  assert.equal(f.events.at(-1), "restored");
  const done = JSON.parse(
    await readFile(join(f.directory, "owner-collected"), "utf8"),
  );
  assert.equal(done.status, "failed");
});

test("a foreign drained request never enters the collector", async (t) => {
  assert.equal(typeof implementation.withSessionOwnerDrain, "function");
  const f = await fixture(t);
  const pending = implementation.withSessionOwnerDrain(
    input(),
    () => assert.fail("foreign acknowledgement"),
    f.options,
  );
  let request;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      request = JSON.parse(
        await readFile(join(f.directory, "request-owner-drain"), "utf8"),
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(5);
    }
  }
  assert(request);
  request.nonce = "00000000-0000-4000-8000-000000000000";
  await writeFile(
    join(f.directory, "owner-drained"),
    JSON.stringify({ request, lifecycle: f.receipt }),
  );
  await assert.rejects(pending);
});

test("cancellation inside the collector remains a failure after restoration", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const results = await Promise.allSettled([
    f.serve(),
    implementation.withSessionOwnerDrain(
      input(),
      async () => {
        controller.abort(new Error("collection cancelled"));
        return "must-not-pass";
      },
      { ...f.options, signal: controller.signal },
    ),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(f.events.at(-1), "restored");
  const done = JSON.parse(
    await readFile(join(f.directory, "owner-collected"), "utf8"),
  );
  assert.equal(done.status, "failed");
});

test("failure publishing collection completion still waits for restoration", async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  let settled = false;
  const host = f
    .serve({
      async createLifecycle() {
        return {
          baseline: f.receipt.baseline,
          async collect(callback) {
            try {
              return await callback(f.receipt);
            } finally {
              entered.resolve();
              await finish.promise;
              restore(f.receipt);
            }
          },
        };
      },
    })
    .catch((error) => error);
  const client = implementation
    .withSessionOwnerDrain(
      input(),
      async () => {
        await mkdir(join(f.directory, "owner-collected"));
      },
      f.options,
    )
    .then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
  try {
    await entered.promise;
    await delay(40);
    assert.equal(settled, false, "client released before restoration joined");
  } finally {
    finish.resolve();
    const results = await Promise.all([host, client]);
    assert(results.every((result) => result instanceof Error));
  }
});

test("the actual stop receipt must retain the acknowledged Identity generation", async (t) => {
  const f = await fixture(t);
  let collected = false;
  const results = await Promise.allSettled([
    f.serve({
      async createLifecycle() {
        return {
          baseline: f.receipt.baseline,
          async collect(callback) {
            for (const key of ["baseline", "before", "after"])
              f.receipt[key]["identity-service"].id = "9".repeat(64);
            try {
              return await callback(f.receipt);
            } finally {
              restore(f.receipt);
            }
          },
        };
      },
    }),
    implementation.withSessionOwnerDrain(
      input(),
      async () => {
        collected = true;
      },
      f.options,
    ),
  ]);
  assert.equal(collected, false);
  assert(results.every((result) => result.status === "rejected"));
});

test("cancellation during restoration joins the healthy receipt and remains a failure", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const failure = new Error("cancelled while restoring");
  const results = await Promise.allSettled([
    f.serve({
      async createLifecycle() {
        return {
          baseline: f.receipt.baseline,
          async collect(callback) {
            try {
              return await callback(f.receipt);
            } finally {
              controller.abort(failure);
              restore(f.receipt);
              f.events.push("restored");
            }
          },
        };
      },
    }),
    implementation.withSessionOwnerDrain(input(), async () => "collected", {
      ...f.options,
      signal: controller.signal,
    }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(f.events.at(-1), "restored");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason, failure);
});

test("same Identity container with a later process cannot admit collection", async (t) => {
  const f = await fixture(t);
  let collected = false;
  const results = await Promise.allSettled([
    f.serve({
      async createLifecycle() {
        return {
          baseline: f.receipt.baseline,
          async collect(callback) {
            for (const key of ["baseline", "before", "after"])
              f.receipt[key]["identity-service"].started_at =
                "2026-10-15T10:00:00.001Z";
            try {
              return await callback(f.receipt);
            } finally {
              restore(f.receipt);
            }
          },
        };
      },
    }),
    implementation.withSessionOwnerDrain(
      input(),
      async () => {
        collected = true;
      },
      f.options,
    ),
  ]);
  assert.equal(collected, false);
  assert(results.every((result) => result.status === "rejected"));
});
