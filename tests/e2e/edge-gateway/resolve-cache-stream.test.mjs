import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { observeWorkspaceStream } from "./resolve-cache-stream.mjs";
import { reset, delta } from "./resolve-cache-stream-fixtures.mjs";

async function fixture(
  t,
  { headers = {}, initial = reset("session-1", 2), omitTrace = false } = {},
) {
  let response,
    observer,
    requests = 0;
  const server = createServer((request, reply) => {
    requests++;
    assert.equal(
      request.url,
      "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
    );
    response = reply;
    reply.writeHead(200, {
      "content-type": "text/event-stream",
      ...(omitTrace ? {} : { "x-antnest-trace-id": "a".repeat(32) }),
      ...headers,
    });
    reply.flushHeaders();
    if (initial)
      reply.write(
        `event: ${initial.type}\ndata: ${JSON.stringify(initial)}\n\n`,
      );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await observer?.closeAndWait().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const client = {
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: "synthetic",
  };
  return {
    async open(signal, options) {
      observer = await observeWorkspaceStream(
        client,
        "agent-1",
        "session-1",
        signal,
        options,
      );
      return observer;
    },
    write(event, name = event.type) {
      response.write(
        `${name === null ? "" : `event: ${name}\n`}data: ${JSON.stringify(event)}\n\n`,
      );
    },
    raw(frame) {
      response.write(frame);
    },
    end() {
      response.end();
    },
    get requests() {
      return requests;
    },
  };
}

for (const mode of ["missing", "malformed"])
  test(`Workspace auxiliary Trace mode retains real ${mode} header and joins the observer`, async (t) => {
    const f = await fixture(t, {
      omitTrace: mode === "missing",
      headers: mode === "malformed" ? { "x-antnest-trace-id": "invalid" } : {},
    });
    const stream = await f.open(undefined, { requireTrace: false });
    await stream.wait(() => true);
    f.write(delta());
    await stream.wait((view) => view.selectedView?.title === "Renamed");
    assert.equal(
      stream.evidence.trace_id,
      mode === "missing" ? null : "invalid",
    );
    assert.equal(f.requests, 1);
    f.end();
    assert.equal((await stream.waitClosed(1000)).kind, "remote-end");
    await stream.closeAndWait();
    assert.equal(stream.evidence.reader_cleanup.outcome, "cancelled");
    assert(stream.evidence.joined.at >= stream.closure.at);
    assert(Number.isSafeInteger(stream.evidence.joined.observed_at_ms));
  });

for (const headers of [
  { "content-type": "application/json" },
  { "set-cookie": "unexpected=renewal" },
])
  test(`Workspace auxiliary Trace mode still rejects ${Object.keys(headers)[0]}`, async (t) => {
    const f = await fixture(t, { headers, omitTrace: true });
    await assert.rejects(f.open(undefined, { requireTrace: false }));
  });

test("Workspace auxiliary Trace mode retains scoped event validation", async (t) => {
  const f = await fixture(t, { omitTrace: true });
  const stream = await f.open(undefined, { requireTrace: false });
  await stream.wait(() => true);
  const event = delta();
  event.agentId = "other-agent";
  f.write(event);
  await assert.rejects(
    stream.wait(() => false),
    /Workspace event/u,
  );
});

test("Workspace observer binds its dispatch Cookie to a private credential observation ID", async (t) => {
  const f = await fixture(t);
  let called = 0;
  const stream = await f.open(undefined, {
    credentialScope(cookie) {
      assert.equal(cookie, "synthetic");
      called++;
      return "scope-only";
    },
  });
  assert.equal(called, 1);
  assert.equal(stream.evidence.credential_scope, "scope-only");
  assert.equal(
    stream.evidence.path,
    "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
  );
  assert.equal(stream.evidence.set_cookie_count, 0);
  assert(!JSON.stringify(stream.evidence).includes("synthetic"));
  await stream.closeAndWait();
});

test("Workspace observer retains real header and scoped snapshot/delta content without reconnecting", async (t) => {
  const f = await fixture(t),
    stream = await f.open();
  const first = await stream.wait((view) => view.selectedView?.title === null);
  stream.assertOpen();
  f.write(delta());
  const next = await stream.wait(
    (view) => view.selectedView?.title === "Renamed",
  );
  assert(next.at >= first.at);
  assert.equal(next.view.selectedView.outputWatermark, 2);
  assert.equal(stream.evidence.trace_id, "a".repeat(32));
  assert.equal(stream.evidence.status, 200);
  assert.equal(stream.evidence.events.length, 2);
  assert.equal(stream.evidence.events[1].raw.type, "delta");
  assert.equal(f.requests, 1);
  f.end();
  const ended = await stream.waitClosed(1000);
  assert.equal(ended.kind, "remote-end");
  await stream.closeAndWait();
  assert.equal(stream.closure, ended);
  assert.equal(f.requests, 1);
});

for (const [name, mutate] of [
  [
    "wrong Agent",
    (event) => {
      event.agentId = "foreign";
    },
  ],
  [
    "wrong Session",
    (event) => {
      event.sessionId = "foreign";
    },
  ],
  [
    "revision gap",
    (event) => {
      event.fromStreamRevision = 7;
      event.toStreamRevision = 8;
    },
  ],
  [
    "projection replacement",
    (event) => {
      event.projectionId = "foreign";
    },
  ],
  [
    "invalid patch",
    (event) => {
      event.patch = [
        { op: "replace", path: "/selectedView/sessionId", value: "foreign" },
      ];
    },
  ],
])
  test(`Workspace observer rejects ${name} without falling back to a new HTTP snapshot`, async (t) => {
    const f = await fixture(t),
      stream = await f.open();
    await stream.wait(() => true);
    const event = delta();
    mutate(event);
    f.write(event);
    await assert.rejects(
      stream.wait((view) => view.selectedView?.title === "Renamed"),
      /Workspace event/u,
    );
    assert.equal(stream.closure.kind, "invalid-event");
    assert.equal(f.requests, 1);
  });

for (const mode of ["local-close", "aborted"])
  test(`Workspace ${mode} cannot become remote revocation after cleanup`, async (t) => {
    const f = await fixture(t),
      abort = new AbortController();
    const stream = await f.open(abort.signal);
    await stream.wait(() => true);
    if (mode === "local-close") await stream.closeAndWait();
    else abort.abort(new Error("test interruption"));
    const closure = await stream.waitClosed(1000);
    assert.equal(closure.kind, mode);
    f.end();
    await stream.closeAndWait();
    assert.equal(stream.closure, closure);
    assert.equal(f.requests, 1);
  });

for (const name of [null, "unrelated", "snapshot", "delta\nevent: delta"])
  test(`Workspace observer cannot accept a delta under event name ${name}`, async (t) => {
    const f = await fixture(t),
      stream = await f.open();
    await stream.wait(() => true);
    f.write(delta(), name);
    await assert.rejects(
      stream.wait((view) => view.selectedView?.title === "Renamed"),
      /Workspace event/u,
    );
    assert.equal(stream.closure.kind, "invalid-event");
    assert.equal(f.requests, 1);
  });

test("Workspace observer rejects empty named data instead of treating it as a heartbeat", async (t) => {
  const f = await fixture(t),
    stream = await f.open();
  await stream.wait(() => true);
  f.raw("event: delta\ndata:\n\n");
  f.write(delta());
  await assert.rejects(
    stream.wait((view) => view.selectedView?.title === "Renamed"),
    /Workspace event/u,
  );
  assert.equal(stream.closure.kind, "invalid-event");
  assert.equal(f.requests, 1);
});

test("Workspace comment heartbeats do not replace the last valid view", async (t) => {
  const f = await fixture(t),
    stream = await f.open();
  await stream.wait(() => true);
  f.raw(": heartbeat\n\n");
  f.write(delta());
  await stream.wait((view) => view.selectedView?.title === "Renamed");
  stream.assertOpen();
  assert.equal(stream.records.length, 2);
  assert.equal(f.requests, 1);
});

test("an access_revoked event still needs actual remote transport closure", async (t) => {
  const f = await fixture(t),
    stream = await f.open();
  await stream.wait(() => true);
  f.write({ ...delta(), type: "access_revoked" });
  for (let i = 0; i < 100 && !stream.revoked; i++) await delay(5);
  assert(stream.revoked);
  assert.equal(stream.closure, undefined);
  assert.throws(() => stream.assertOpen(), /revoked/u);
  f.end();
  assert.equal((await stream.waitClosed(1000)).kind, "remote-end");
});

for (const headers of [
  { "x-antnest-trace-id": "invented" },
  { "content-type": "application/json" },
  { "set-cookie": "unexpected=renewal" },
])
  test(`Workspace observer rejects invalid admission ${Object.keys(headers)[0]}`, async (t) => {
    const f = await fixture(t, { headers });
    await assert.rejects(f.open());
    assert.equal(f.requests, 1);
  });

function failingReader(t, options = {}) {
  const { invalidAdmission = false, invalidEvent = false } = options;
  const cleanupError = Object.hasOwn(options, "cleanupError")
    ? options.cleanupError
    : new Error("reader cancellation failed");
  let cancellations = 0,
    releases = 0;
  const reader = {
    async read() {
      if (Object.hasOwn(options, "readFailure")) throw options.readFailure;
      if (invalidEvent)
        return {
          done: false,
          value: Buffer.from("event: unknown\ndata: {}\n\n"),
        };
      return { done: true };
    },
    async cancel() {
      cancellations++;
      throw cleanupError;
    },
    releaseLock() {
      releases++;
    },
  };
  t.mock.method(globalThis, "fetch", async () => ({
    status: 200,
    headers: new Headers({
      "content-type": "text/event-stream",
      "x-antnest-trace-id": invalidAdmission ? "invalid" : "a".repeat(32),
    }),
    body: { getReader: () => reader, cancel: () => reader.cancel() },
  }));
  return { cleanupError, counts: () => ({ cancellations, releases }) };
}

test("Workspace remote EOF preserves a reader cancellation failure and joins cleanup once", async (t) => {
  const f = failingReader(t);
  const stream = await observeWorkspaceStream(
    { base: "http://fixture", cookie: "synthetic" },
    "agent-1",
    "session-1",
  );
  await stream.waitClosed();
  const results = await Promise.allSettled([
    stream.closeAndWait(),
    stream.closeAndWait(),
  ]);
  assert(
    results.every(
      (r) => r.status === "rejected" && r.reason === f.cleanupError,
    ),
  );
  assert.deepEqual(f.counts(), { cancellations: 1, releases: 1 });
});

test("Workspace invalid event retains validation and reader cleanup failures", async (t) => {
  const f = failingReader(t, { invalidEvent: true });
  const stream = await observeWorkspaceStream(
    { base: "http://fixture", cookie: "synthetic" },
    "agent-1",
    "session-1",
  );
  await stream.waitClosed();
  await assert.rejects(stream.closeAndWait(), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /validation failed/u);
    assert.equal(error.errors[1], f.cleanupError);
    return true;
  });
  assert.deepEqual(f.counts(), { cancellations: 1, releases: 1 });
});

test("Workspace failed admission retains response-body cleanup failure", async (t) => {
  const f = failingReader(t, { invalidAdmission: true });
  await assert.rejects(
    observeWorkspaceStream(
      { base: "http://fixture", cookie: "synthetic" },
      "agent-1",
      "session-1",
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[1], f.cleanupError);
      return true;
    },
  );
  assert.deepEqual(f.counts(), { cancellations: 1, releases: 0 });
});

for (const cleanupError of [null, undefined]) {
  for (const invalidEvent of [false, true])
    test(`Workspace ${invalidEvent ? "validation failure" : "EOF"} retains ${String(cleanupError)} cancellation and joins cleanup`, async (t) => {
      const f = failingReader(t, { cleanupError, invalidEvent });
      const stream = await observeWorkspaceStream(
        { base: "http://fixture", cookie: "synthetic" },
        "agent-1",
        "session-1",
      );
      await stream.waitClosed();
      const results = await Promise.allSettled([
        stream.closeAndWait(),
        stream.closeAndWait(),
      ]);
      for (const result of results) {
        assert.equal(result.status, "rejected");
        if (invalidEvent) {
          assert(result.reason instanceof AggregateError);
          assert.equal(result.reason.errors.length, 2);
          assert.match(result.reason.errors[0].message, /validation failed/u);
          assert.equal(result.reason.errors[1], cleanupError);
        } else assert.equal(result.reason, cleanupError);
      }
      assert.equal(stream.evidence.reader_cleanup.outcome, "failed");
      assert.equal(
        stream.evidence.reader_cleanup.error.message,
        String(cleanupError),
      );
      assert.deepEqual(f.counts(), { cancellations: 1, releases: 1 });
    });

  test(`Workspace matching ${String(cleanupError)} read and cancel failures retain transport closure`, async (t) => {
    const f = failingReader(t, { cleanupError, readFailure: cleanupError });
    const stream = await observeWorkspaceStream(
      { base: "http://fixture", cookie: "synthetic" },
      "agent-1",
      "session-1",
    );
    await stream.waitClosed();
    assert.equal((await stream.closeAndWait()).kind, "transport-end");
    assert.equal(stream.evidence.reader_cleanup.outcome, "already-terminated");
    assert.deepEqual(f.counts(), { cancellations: 1, releases: 1 });
  });
}
