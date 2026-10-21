import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
const runtimeURL = new URL("./runtime-inspection.mjs", import.meta.url);
const runtime = await import(runtimeURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(runtimeURL.pathname)
  )
    throw error;
  return {};
});
const requestPermissionRuntimeInspection = (...args) => {
  assert.equal(typeof runtime.requestPermissionRuntimeInspection, "function");
  return runtime.requestPermissionRuntimeInspection(...args);
};
const servePermissionRuntimeInspection = (...args) => {
  assert.equal(typeof runtime.servePermissionRuntimeInspection, "function");
  return runtime.servePermissionRuntimeInspection(...args);
};

const cleanupURL = new URL("./cleanup-evidence.mjs", import.meta.url);
const implementation = await import(cleanupURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(cleanupURL.pathname)
  )
    throw error;
  return {};
});
const run = async (...args) => {
  assert.equal(typeof implementation.withPermissionAgentCleanup, "function");
  return implementation.withPermissionAgentCleanup(...args);
};
const agents = ["agent-one", "agent-two"];
const project = "antnest-stage3-e2e-1234";
const runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
const env = {
  COMPOSE_PROJECT_NAME: project,
  ANTNEST_E2E_RUN_ID: runID,
  TEST_RUNTIME_IMAGE: `antnest/antnest-runtime:permission-${runID}`,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proof = () => ({
  raw_sha256: "a".repeat(64),
  runtimes: agents.map((agent_id, index) => ({
    project,
    agent_id,
    generation: 1,
    container_id: String(index + 1).repeat(64),
    image_id: "sha256:" + "4".repeat(64),
    image_ref: env.TEST_RUNTIME_IMAGE,
    started_at: "2026-10-16T00:00:00.123456789Z",
  })),
});
async function fixture(
  t,
  failFirst = false,
  mutation,
  traceID = "b".repeat(32),
) {
  assert.equal(typeof implementation.withPermissionAgentCleanup, "function");
  const directory = await mkdtemp(
    join(tmpdir(), "antnest-permission-cleanup-"),
  );
  const calls = [],
    bodies = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      void _chunk;
    }
    calls.push({ method: request.method, path: request.url });
    const deletion = request.method === "POST";
    response.statusCode = deletion
      ? failFirst && request.url.includes("agent-one")
        ? 503
        : 202
      : 200;
    if (deletion && mutation === "wrong delete status")
      response.statusCode = 200;
    if (traceID !== null) response.setHeader("x-antnest-trace-id", traceID);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader(
      "set-cookie",
      "private-header=DO_NOT_ARCHIVE; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
    const name = request.url.match(/(?:agent|operation)-(one|two)/u)?.[1];
    assert(name);
    const agent = `agent-${name}`;
    const operation = `operation-${name}`;
    const body = deletion
      ? {
          request_id:
            mutation === "duplicate operation" ? "operation-one" : operation,
          agent_id: agent,
          kind: "delete",
        }
      : {
          request_id: operation,
          agent_id: agent,
          kind: "delete",
          state: mutation === "failed terminal" ? "failed" : "completed",
        };
    if (!deletion && mutation === "foreign operation")
      body.request_id = "foreign";
    if (!deletion && mutation === "foreign Agent") body.agent_id = "foreign";
    if (!deletion && mutation === "wrong operation kind") body.kind = "rebuild";
    const text = JSON.stringify(body, null, 3) + "\n";
    bodies.push(text);
    response.end(text);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const pending = [];
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await Promise.allSettled(pending);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const options = { env, directory, signal: controller.signal, wait: turn };
  return {
    directory,
    calls,
    bodies,
    options,
    client: new GatewayClient(`http://127.0.0.1:${server.address().port}`),
    track(promise) {
      pending.push(promise);
      promise.catch(() => {});
      return promise;
    },
    host(inspect = async () => proof()) {
      return this.track(
        servePermissionRuntimeInspection({ ...options, inspect }),
      );
    },
  };
}
const summary = async (f) =>
  JSON.parse(
    await readFile(join(f.directory, "cleanup-lifecycle.private.json"), "utf8"),
  );

test("actual HTTP deletion and completed operations follow the consumed host ACK on one client clock", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const host = f.host(async () => {
    entered.resolve();
    await release.promise;
    return proof();
  });
  const client = f.track(
    run(
      agents,
      f.client,
      (consumed) =>
        requestPermissionRuntimeInspection(agents, { ...f.options, consumed }),
      { directory: f.directory },
    ),
  );
  try {
    await Promise.race([
      entered.promise,
      client.then(() => assert.fail("cleanup before host inspection")),
    ]);
    assert.deepEqual(f.calls, []);
  } finally {
    release.resolve();
  }
  await Promise.all([host, client]);
  const report = await summary(f);
  assert.equal(report.status, "verified");
  assert.equal(report.process_pid, process.pid);
  assert.match(report.clock_id, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(report.agent_ids, agents);
  const ack = report.events.find(
    (event) => event.kind === "runtime-ack-consumed",
  );
  assert(ack);
  assert.equal(ack.request.project, project);
  assert.equal(ack.request.run_id, runID);
  const ackBytes = await readFile(join(f.directory, ack.file));
  assert.equal(hash(ackBytes), ack.sha256);
  assert.deepEqual(
    ackBytes,
    await readFile(join(f.directory, "runtime-receipt.json")),
  );
  const starts = report.events.filter(
    (event) => event.kind === "request-start",
  );
  assert.deepEqual(
    starts.map(({ method, path }) => ({ method, path })),
    f.calls,
  );
  assert.equal(starts.length, 4);
  for (const start of starts) {
    assert(
      start.sequence > ack.sequence && start.monotonic_ms >= ack.monotonic_ms,
    );
    const completed = report.events.find(
      (event) =>
        event.kind === "response-complete" &&
        event.request_sequence === start.sequence,
    );
    assert(
      completed &&
        completed.sequence > start.sequence &&
        completed.monotonic_ms >= start.monotonic_ms,
    );
    assert.equal(completed.status, start.method === "POST" ? 202 : 200);
    assert.equal(completed.trace_id, "b".repeat(32));
    const text = await readFile(join(f.directory, completed.file), "utf8");
    assert.equal(text, f.bodies[starts.indexOf(start)]);
    assert.equal(hash(text), completed.sha256);
  }
  for (const file of await readdir(f.directory))
    assert(
      !(await readFile(join(f.directory, file), "utf8")).includes(
        "DO_NOT_ARCHIVE",
      ),
    );
});

for (const mode of [
  "business failure",
  "first delete failure",
  "evidence write failure",
])
  test(`cleanup still attempts both Agents after ${mode}`, async (t) => {
    const f = await fixture(t, mode === "first delete failure");
    const primary = new Error("original business failure");
    let host;
    const action = async (consumed) => {
      if (mode === "business failure") throw primary;
      if (mode === "evidence write failure")
        await mkdir(join(f.directory, "runtime-ack-consumed.raw"));
      host = f.host();
      return requestPermissionRuntimeInspection(agents, {
        ...f.options,
        consumed,
      });
    };
    await assert.rejects(
      run(agents, f.client, action, { directory: f.directory }),
      mode === "business failure" ? (error) => error === primary : undefined,
    );
    if (host) await host;
    assert.deepEqual(
      f.calls.filter((call) => call.method === "POST").map((call) => call.path),
      agents.map((id) => `/api/admin/agents/${id}/delete`),
    );
    assert.equal((await summary(f)).status, "failed");
    if (mode === "first delete failure") {
      const response = (await summary(f)).events.find(
        (row) => row.kind === "response-complete" && row.status === 503,
      );
      assert(response, "actual failed HTTP response must be retained");
      assert.equal(response.trace_id, "b".repeat(32));
      assert.equal(
        await readFile(join(f.directory, response.file), "utf8"),
        f.bodies[0],
      );
    }
  });

for (const mutation of [
  "duplicate operation",
  "foreign operation",
  "foreign Agent",
  "wrong operation kind",
])
  test(`cleanup receipt rejects ${mutation}`, async (t) => {
    const f = await fixture(t, false, mutation);
    const host = f.host();
    await assert.rejects(
      run(
        agents,
        f.client,
        (consumed) =>
          requestPermissionRuntimeInspection(agents, {
            ...f.options,
            consumed,
          }),
        { directory: f.directory },
      ),
    );
    await host;
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
    assert.equal((await summary(f)).status, "failed");
  });

test("successful business without a consumed Runtime ACK still cleans both Agents and fails admission", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    run(agents, f.client, async () => "business-complete", {
      directory: f.directory,
    }),
    /consumed Runtime ACK/,
  );
  assert.deepEqual(
    f.calls.filter((row) => row.method === "POST").map((row) => row.path),
    agents.map((id) => `/api/admin/agents/${id}/delete`),
  );
  assert.equal((await summary(f)).status, "failed");
});

test("business and deletion failures both survive after the second Agent is cleaned", async (t) => {
  const f = await fixture(t, true),
    original = new Error("original permission business failure");
  await assert.rejects(
    run(
      agents,
      f.client,
      async () => {
        throw original;
      },
      { directory: f.directory },
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors[0], original);
      assert(error.errors[1] instanceof AggregateError);
      return true;
    },
  );
  assert.deepEqual(
    f.calls.filter((row) => row.method === "POST").map((row) => row.path),
    agents.map((id) => `/api/admin/agents/${id}/delete`),
  );
  assert.equal(f.calls.at(-1).path, "/api/admin/operations/operation-two");
  assert.equal((await summary(f)).status, "failed");
});

for (const [label, traceID] of [
  ["missing", null],
  ["malformed", "unavailable-cleanup-trace"],
])
  test(`cleanup business admission retains real ACK deletion and response bytes with ${label} Trace while default remains strict`, async (t) => {
    const f = await fixture(t, false, undefined, traceID);
    const host = f.host();
    const result = await f.track(
      run(
        agents,
        f.client,
        (consumed) =>
          requestPermissionRuntimeInspection(agents, {
            ...f.options,
            consumed,
          }),
        { directory: f.directory, requireTrace: false },
      ),
    );
    await host;
    assert.equal(result.runtimes.length, 2);
    const report = await summary(f);
    assert.equal(report.status, "verified");
    assert.equal(report.evidence_error_count, 0);
    const ack = report.events.find(
      (row) => row.kind === "runtime-ack-consumed",
    );
    assert(ack);
    assert.deepEqual(ack.request.agent_ids, agents);
    const ackBytes = await readFile(join(f.directory, ack.file));
    assert.equal(hash(ackBytes), ack.sha256);
    assert.deepEqual(
      ackBytes,
      await readFile(join(f.directory, "runtime-receipt.json")),
    );
    const starts = report.events.filter((row) => row.kind === "request-start");
    assert.deepEqual(
      starts.map(({ method, path }) => ({ method, path })),
      f.calls,
    );
    assert.equal(starts.length, 4);
    for (const [index, start] of starts.entries()) {
      assert(
        start.sequence > ack.sequence && start.monotonic_ms >= ack.monotonic_ms,
      );
      const response = report.events.find(
        (row) =>
          row.kind === "response-complete" &&
          row.request_sequence === start.sequence,
      );
      assert(
        response &&
          response.sequence > start.sequence &&
          response.monotonic_ms >= start.monotonic_ms,
      );
      assert.equal(response.status, start.method === "POST" ? 202 : 200);
      assert.equal(response.trace_id, traceID);
      const bytes = await readFile(join(f.directory, response.file));
      assert.equal(bytes.toString("utf8"), f.bodies[index]);
      assert.equal(hash(bytes), response.sha256);
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), response.body);
      assert.equal(response.body.kind, "delete");
      assert(agents.includes(response.body.agent_id));
      if (start.method === "GET")
        assert.equal(response.body.state, "completed");
    }
    const strict = await fixture(t, false, undefined, traceID);
    const strictHost = strict.host();
    await assert.rejects(
      strict.track(
        run(
          agents,
          strict.client,
          (consumed) =>
            requestPermissionRuntimeInspection(agents, {
              ...strict.options,
              consumed,
            }),
          { directory: strict.directory },
        ),
      ),
      (error) => error.operator === "match",
    );
    await strictHost;
    assert.equal(strict.calls.filter((row) => row.method === "POST").length, 2);
    assert.equal((await summary(strict)).status, "failed");
  });

test("cleanup business admission rejects foreign or incomplete operation facts without Trace after joining both deletions", async (t) => {
  for (const mutation of [
    "duplicate operation",
    "foreign operation",
    "foreign Agent",
    "wrong operation kind",
    "wrong delete status",
    "failed terminal",
  ]) {
    const f = await fixture(t, false, mutation, null);
    const host = f.host();
    await assert.rejects(
      f.track(
        run(
          agents,
          f.client,
          (consumed) =>
            requestPermissionRuntimeInspection(agents, {
              ...f.options,
              consumed,
            }),
          { directory: f.directory, requireTrace: false },
        ),
      ),
      undefined,
      mutation,
    );
    await host;
    assert.deepEqual(
      f.calls.filter((row) => row.method === "POST").map((row) => row.path),
      agents.map((agent) => `/api/admin/agents/${agent}/delete`),
    );
    const report = await summary(f);
    assert.equal(report.status, "failed", mutation);
    assert.equal(
      report.evidence_error_count,
      0,
      "operation rejection was replaced by an archive failure",
    );
  }
});

test("cleanup business admission still requires an ACK for exactly the original Agents without Trace", async (t) => {
  for (const mutation of ["missing ACK", "foreign ACK Agent"]) {
    const f = await fixture(t, false, undefined, null);
    let host;
    await assert.rejects(
      f.track(
        run(
          agents,
          f.client,
          async (consumed) => {
            if (mutation === "missing ACK") return "business-complete";
            host = f.host();
            return requestPermissionRuntimeInspection(agents, {
              ...f.options,
              consumed: (_bytes, receipt) => {
                const changed = structuredClone(receipt);
                changed.request.agent_ids = [agents[0], "foreign-Agent"];
                consumed(Buffer.from(JSON.stringify(changed)), changed);
              },
            });
          },
          { directory: f.directory, requireTrace: false },
        ),
      ),
      undefined,
      mutation,
    );
    if (host) await host;
    assert.deepEqual(
      f.calls.filter((row) => row.method === "POST").map((row) => row.path),
      agents.map((agent) => `/api/admin/agents/${agent}/delete`),
    );
    assert.equal(f.calls.at(-1).path, "/api/admin/operations/operation-two");
    assert.equal((await summary(f)).status, "failed");
  }
});

test("cleanup business admission rejects an actual Runtime ACK consumed only after deletion started", async (t) => {
  const f = await fixture(t, false, undefined, null),
    request = f.client.request.bind(f.client);
  let deliver;
  f.client.request = (path, options) => {
    if (deliver && path.endsWith("/delete")) {
      const consume = deliver;
      deliver = undefined;
      consume();
    }
    return request(path, options);
  };
  const host = f.host();
  await assert.rejects(
    f.track(
      run(
        agents,
        f.client,
        (consumed) =>
          requestPermissionRuntimeInspection(agents, {
            ...f.options,
            consumed: (bytes, receipt) => {
              deliver = () => consumed(bytes, receipt);
            },
          }),
        { directory: f.directory, requireTrace: false },
      ),
    ),
    /Agent deleted before consuming Runtime ACK/u,
  );
  await host;
  const report = await summary(f),
    ack = report.events.find((row) => row.kind === "runtime-ack-consumed");
  const first = report.events.find((row) => row.kind === "request-start");
  assert(ack && first && first.sequence < ack.sequence);
  assert.equal(report.status, "failed");
  assert.equal(f.calls.filter((row) => row.method === "POST").length, 2);
  assert.equal(f.calls.at(-1).path, "/api/admin/operations/operation-two");
});

for (const mode of ["first delete failure", "raw response archive failure"])
  test(`cleanup business admission joins the held second terminal response after ${mode} without Trace`, async (t) => {
    const f = await fixture(
      t,
      mode === "first delete failure",
      undefined,
      null,
    );
    if (mode === "raw response archive failure")
      await mkdir(join(f.directory, "cleanup-response-0002.raw"));
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const request = f.client.request.bind(f.client);
    f.client.request = async (path, options) => {
      if (path === "/api/admin/operations/operation-two") {
        entered.resolve();
        await release.promise;
      }
      return request(path, options);
    };
    const host = f.host();
    let settled = false,
      result;
    const pending = f.track(
      run(
        agents,
        f.client,
        (consumed) =>
          requestPermissionRuntimeInspection(agents, {
            ...f.options,
            consumed,
          }),
        { directory: f.directory, requireTrace: false },
      ).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        },
      ),
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then(() =>
          assert.fail("cleanup settled before the second terminal response"),
        ),
      ]);
      assert.equal(
        settled,
        false,
        "cleanup did not join the second Agent operation",
      );
    } finally {
      release.resolve();
      result = await pending;
      await host;
    }
    assert(
      result.error,
      "real cleanup or original archive failure was swallowed",
    );
    assert.equal(f.calls.filter((row) => row.method === "POST").length, 2);
    assert.equal(f.calls.at(-1).path, "/api/admin/operations/operation-two");
    const report = await summary(f);
    assert.equal(report.status, "failed");
    if (mode === "raw response archive failure")
      assert(report.evidence_error_count > 0);
  });
