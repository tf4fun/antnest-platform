import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { inspect } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { observeC4PageStreams } from "./c4-stream-observer.mjs";

const moduleURL = new URL("./c4-revocation.mjs", import.meta.url);
const {
  snapshotC4Execution,
  assertC4NoNewExecution,
  rejectC4Prompt,
  c4OffboardingExpected,
} = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});

function offboardingFixture() {
  return {
    agentId: "agent-1",
    ownerId: "owner-1",
    traceID: "a".repeat(32),
    before: { events: [{ event_id: "old" }] },
    after: {
      events: [
        { event_id: "old" },
        {
          event_id: "owner-event",
          event_type: "agent_owner_revoked",
          agent_id: "agent-1",
          trace_id: "a".repeat(32),
        },
        {
          event_id: "disabled-event",
          event_type: "agent_disabled",
          agent_id: "agent-1",
          trace_id: "a".repeat(32),
          operation_request_id: "disable-operation",
        },
      ],
    },
  };
}

test("C4 binds the new public owner and Disable events to its original user-deactivation Trace", () => {
  assert.equal(typeof c4OffboardingExpected, "function");
  const source = offboardingFixture(),
    result = c4OffboardingExpected(source);
  assert.equal(result.sourceID, source.traceID);
  assert.equal(result.requestID, "disable-operation");
  assert.equal(result.settlementOutcome, "settled");
  assert.equal(result.ownerRevocation.reason, "user_deactivated");
  assert.equal(result.ownerRevocation.ownerUserID, source.ownerId);
  assert.equal(result.ownerRevocation.organizationID, "");
  assert.equal(Object.hasOwn(result.ownerRevocation.event, "data"), false);
});

for (const [name, change] of [
  ["missing owner event", (f) => f.after.events.splice(1, 1)],
  [
    "duplicate owner event",
    (f) => f.after.events.push({ ...f.after.events[1], event_id: "duplicate" }),
  ],
  [
    "foreign mutation Trace",
    (f) => {
      f.after.events[1].trace_id = "b".repeat(32);
    },
  ],
  [
    "foreign Agent Disable",
    (f) => {
      f.after.events[2].agent_id = "other";
    },
  ],
  [
    "missing operation",
    (f) => {
      delete f.after.events[2].operation_request_id;
    },
  ],
  [
    "potentially truncated events",
    (f) => {
      while (f.after.events.length < 100)
        f.after.events.push({ event_id: `filler-${f.after.events.length}` });
    },
  ],
])
  test(`C4 refuses ${name} as its offboarding observation`, () => {
    assert.equal(typeof c4OffboardingExpected, "function");
    const source = offboardingFixture();
    change(source);
    assert.throws(() => c4OffboardingExpected(source));
  });

function inventory() {
  const calls = [];
  const values = {
    "/api/admin/execution-audits?agent_id=agent-1&limit=100": {
      items: [1, 2].map((i) => ({ run_id: `run-${i}`, agent_id: "agent-1" })),
      next_cursor: null,
    },
  };
  for (const i of [1, 2]) {
    values[`/api/admin/execution-audits/run-${i}`] = {
      run_id: `run-${i}`,
      agent_id: "agent-1",
      status: "completed",
      usage: { tokens: i },
    };
    values[`/api/admin/execution-audits/run-${i}/events?limit=100`] = {
      stream: "execution",
      items: [{ id: `event-${i}`, payload: { text: "retained history" } }],
      next_cursor: null,
    };
  }
  const status = {
    requests: [{ phase: "original", trace_id: "b".repeat(32) }],
    pending: [],
    errors: [],
  };
  const fixture = {
    agentID: "agent-1",
    json: async (path) => {
      calls.push(path);
      assert(Object.hasOwn(values, path), "unexpected inventory endpoint");
      return values[path];
    },
  };
  return {
    calls,
    values,
    status,
    fixture,
    read: () => snapshotC4Execution(fixture, async () => status),
  };
}

test("C4 zero-execution evidence snapshots every Run, full event page and Provider request", async () => {
  assert.equal(typeof snapshotC4Execution, "function");
  const f = inventory(),
    before = await f.read();
  assert.equal(f.calls.length, 5);
  assert.equal(before.audits.all.length, 2);
  assertC4NoNewExecution(before, await f.read());
  f.values["/api/admin/execution-audits/run-2"].usage.tokens++;
  assert.throws(() =>
    assertC4NoNewExecution(before, {
      ...before,
      audits: { ...before.audits, all: [] },
    }),
  );
  assert.equal(
    before.audits.all[1].run.usage.tokens,
    2,
    "snapshot must not alias mutable API data",
  );
  assert.throws(() =>
    assertC4NoNewExecution(before, {
      ...before,
      model: { ...before.model, requests: [] },
    }),
  );
});

test("C4 cannot admit missing execution inventories", () => {
  assert.equal(typeof assertC4NoNewExecution, "function");
  assert.throws(() => assertC4NoNewExecution(undefined, undefined));
  assert.throws(() => assertC4NoNewExecution({}, {}));
});

for (const [name, change] of [
  [
    "incomplete Run inventory",
    (f) => {
      f.values[
        "/api/admin/execution-audits?agent_id=agent-1&limit=100"
      ].next_cursor = "more";
    },
  ],
  [
    "incomplete event inventory",
    (f) => {
      f.values[
        "/api/admin/execution-audits/run-2/events?limit=100"
      ].next_cursor = "more";
    },
  ],
  [
    "duplicate Run",
    (f) => {
      f.values[
        "/api/admin/execution-audits?agent_id=agent-1&limit=100"
      ].items[1].run_id = "run-1";
    },
  ],
  [
    "foreign Run detail",
    (f) => {
      f.values["/api/admin/execution-audits/run-2"].agent_id = "other";
    },
  ],
  [
    "pending model request",
    (f) => {
      f.status.pending.push("original");
    },
  ],
  [
    "model error",
    (f) => {
      f.status.errors.push("original error");
    },
  ],
])
  test(`C4 refuses ${name} as zero-execution evidence`, async () => {
    assert.equal(typeof snapshotC4Execution, "function");
    const f = inventory();
    change(f);
    await assert.rejects(f.read());
  });

for (const [name, change] of [
  [
    "new Run",
    (v) => {
      v.audits.page.items.push({ run_id: "new", agent_id: "agent-1" });
    },
  ],
  [
    "old Run mutation",
    (v) => {
      v.audits.all[1].run.usage.tokens++;
    },
  ],
  [
    "old history mutation",
    (v) => {
      v.audits.all[1].events.items[0].payload.text = "changed";
    },
  ],
  [
    "same-count Provider replacement",
    (v) => {
      v.model.requests[0].trace_id = "c".repeat(32);
    },
  ],
])
  test(`C4 detects ${name} after revocation`, async () => {
    assert.equal(typeof snapshotC4Execution, "function");
    const before = await inventory().read(),
      after = structuredClone(before);
    change(after);
    assert.throws(() => assertC4NoNewExecution(before, after));
  });

const cookies = [
  { name: "antnest_session", value: "C4-ORIGINAL-REVOKED-TOKEN" },
  { name: "antnest_csrf", value: "C4-ORIGINAL-REVOKED-CSRF" },
];
let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
});
after(async () => {
  await browser?.close();
});

async function httpFixture(t, options = {}) {
  assert.equal(typeof rejectC4Prompt, "function");
  const requests = [],
    streams = [],
    pending = new Set(),
    failures = [];
  const server = createServer((request, response) => {
    if (request.url.includes("/events?")) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-antnest-trace-id": "a".repeat(32),
      });
      response.write(": connected\n\n");
      streams.push(response);
      return;
    }
    if (!request.url.endsWith("/prompts")) {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><title>C4</title>");
      return;
    }
    const task = (async () => {
      const parts = [];
      for await (const part of request) parts.push(part);
      requests.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(parts).toString()),
      });
      const code = options.status ?? 401;
      response.writeHead(code, {
        "content-type": "application/json",
        "cache-control": options.cacheControl ?? "no-store",
        "x-antnest-trace-id": options.traceID ?? "b".repeat(32),
        ...(options.setCookie
          ? { "set-cookie": "antnest_session=rotated; Path=/" }
          : {}),
      });
      response.end(
        options.rawBody ??
          JSON.stringify(
            options.body ??
              (code === 403
                ? {
                    code: "access_denied",
                    message: "Agent access denied",
                    retryable: false,
                    recovery: "none",
                    requestId: "request-1",
                  }
                : {
                    code: "unauthenticated",
                    message: "Session is invalid or expired",
                  }),
          ),
      );
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error) => {
        failures.push(error);
        pending.delete(task);
        response.destroy();
      },
    );
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.allSettled([...pending]);
    if (failures.length) throw new AggregateError(failures);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const observer = observeC4PageStreams(page, { gateway, agentId: "agent-1" });
  t.after(async () => {
    await context.close();
    await observer.closeAndWait();
  });
  await context.addCookies(
    cookies.map((cookie) => ({ ...cookie, url: gateway, secure: true })),
  );
  await page.goto(gateway);
  await page.evaluate(() => {
    globalThis.source = new EventSource(
      "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=before-revocation",
    );
    source.onerror = () => source.close();
  });
  const point = await observer.checkpoint({
    sessionId: "session-1",
    cookies,
    timeoutMs: 1000,
  });
  const selectedView = {
    agentId: "agent-1",
    sessionId: "session-1",
    historyToken: "original-history",
    appendVersion: 7,
  };
  const evidence = {};
  return {
    requests,
    streams,
    observer,
    page,
    context,
    gateway,
    point,
    selectedView,
    evidence,
    reject: (overrides = {}) =>
      rejectC4Prompt({
        context,
        gateway,
        observer,
        point,
        selectedView,
        evidence,
        ...overrides,
      }),
    end: async () => {
      streams[0].end();
      await observer.waitForRemoteEnd(point, { timeoutMs: 1000 });
    },
  };
}

for (const status of [401, 403])
  test(`C4 sends the exact original Cookie after page EOF and logout and validates HTTP ${status}`, async (t) => {
    const f = await httpFixture(t, { status });
    await f.end();
    await f.context.clearCookies();
    const receipt = await f.reject();
    assert.equal(f.requests.length, 1);
    const wire = f.requests[0];
    assert.equal(
      wire.headers.cookie,
      cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    );
    assert.equal(wire.headers["x-antnest-csrf-token"], cookies[1].value);
    assert.equal(wire.headers.origin, f.gateway);
    assert.equal(wire.headers["if-match"], "original-history");
    assert.equal(wire.headers["idempotency-key"], wire.body.intentId);
    assert.equal(wire.body.expectedAppendVersion, 7);
    assert.equal(receipt.status, status);
    assert.equal(receipt.credentialScope, f.point.stream.credential_scope);
    assert.equal(receipt.rawBody, JSON.stringify(receipt.body));
    assert(
      receipt.startedMono >=
        (await f.observer.waitForRemoteEnd(f.point)).closure.at,
    );
    assert(
      receipt.startedAt >=
        (await f.observer.waitForRemoteEnd(f.point)).closedAt,
    );
    assert.equal(receipt, f.evidence);
    for (const cookie of cookies)
      assert(!JSON.stringify(receipt).includes(cookie.value));
    assert.equal((await f.context.cookies()).length, 0);
    await assert.rejects(f.reject(), /one C4 denial probe/u);
    assert.equal(f.requests.length, 1);
  });

for (const [name, options] of [
  ["accepted Prompt", { status: 202 }],
  [
    "wrong denial code",
    { body: { code: "identity_unavailable", message: "unavailable" } },
  ],
  ["revoked Cookie rotation", { setCookie: true }],
  ["cacheable rejection", { cacheControl: "public" }],
  ["missing actual Trace", { traceID: "" }],
  [
    "malformed private response",
    { rawBody: "C4-ORIGINAL-REVOKED-TOKEN invalid JSON" },
  ],
])
  test(`C4 rejects ${name} and retains the raw response privately`, async (t) => {
    const f = await httpFixture(t, options);
    await f.end();
    await assert.rejects(f.reject(), (error) => {
      assert(!inspect(error).includes(cookies[0].value));
      return true;
    });
    assert.equal(f.requests.length, 1);
    assert.equal(typeof f.evidence.rawBody, "string");
    assert.equal(f.evidence.status, options.status ?? 401);
  });

test("C4 does not issue a denial probe after local page closure or with a foreign checkpoint", async (t) => {
  const f = await httpFixture(t);
  await f.page.close();
  await assert.rejects(f.reject());
  await assert.rejects(f.reject({ point: structuredClone(f.point) }));
  assert.equal(f.requests.length, 0);
});

test("C4 rejects a foreign Session view before dispatching its denial probe", async (t) => {
  const f = await httpFixture(t);
  await f.end();
  await assert.rejects(
    f.reject({ selectedView: { ...f.selectedView, sessionId: "other" } }),
  );
  assert.equal(f.requests.length, 0);
});

test("C4 never sends original authority to a different Gateway origin", async (t) => {
  const original = await httpFixture(t),
    other = await httpFixture(t);
  await original.end();
  await assert.rejects(original.reject({ gateway: other.gateway }));
  assert.equal(
    other.requests.length,
    0,
    "foreign origin received original authority",
  );
  assert.equal(original.requests.length, 0);
});
