import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import { observeC4Responses } from "./c4-responses.mjs";

const moduleURL = new URL("./c4-body-audit.mjs", import.meta.url);
const implementation = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
const unavailable = () =>
  new Error(
    "response.text: Protocol error (Network.getResponseBody): No resource with given identifier found\nResponse body is not available for a response that was navigated away from.",
  );
function fixture(status = 200, route = "view") {
  assert.equal(typeof implementation.createC4BodyAudit, "function");
  let time = 10,
    currentURL = "http://gateway/workspace/agent/sessions/session";
  const diagnostics = [],
    observers = [],
    failures = [];
  const scope = {
    addObserver: (o) => observers.push(o),
    track: (p) => {
      p.catch((e) => failures.push(e));
      return p;
    },
  };
  const frame = { url: () => currentURL };
  const page = Object.assign(new EventEmitter(), {
    url: () => currentURL,
    mainFrame: () => frame,
  });
  const responseURL =
    route === "view"
      ? "http://gateway/api/app/workspace/v1/agents/agent/view?sessionId=session"
      : "http://gateway/api/app/workspace/v1/bootstrap";
  const request = {
    method: () => "GET",
    frame: () => frame,
    url: () => responseURL,
    redirectedFrom: () => null,
  };
  const body = Promise.withResolvers();
  let reads = 0;
  const response = {
    url: () => responseURL,
    status: () => status,
    request: () => request,
    headers: () => ({ "x-antnest-trace-id": "a".repeat(32) }),
    text: () => {
      reads++;
      return body.promise;
    },
  };
  const audit = implementation.createC4BodyAudit({
    gateway: "http://gateway",
    agentId: "agent",
    diagnostics,
    now: () => time,
  });
  audit.track(page, scope);
  const cause = { startedMono: 20, status: 200, traceID: "b".repeat(32) };
  const arm = () => {
    time = 20;
    audit.arm(page, { sessionId: "session", startedMono: cause.startedMono });
  };
  const navigate = (
    url = "http://gateway/?" +
      new URLSearchParams({ return_to: "/workspace/agent/sessions/session" }),
  ) => {
    time = 30;
    currentURL = url;
    page.emit("framenavigated", frame);
  };
  const fail = (error = unavailable()) => {
    time = 40;
    body.reject(error);
  };
  const report = () => ({
    business_completed: true,
    browser_body_diagnostics: diagnostics,
    browser_revocation: {
      cause,
      selectedView: { agentId: "agent", sessionId: "session" },
      bodyObservation: audit.confirm(page, {
        signInVisible: true,
        composerCount: 0,
        messageCount: 0,
      }),
    },
  });
  return {
    audit,
    page,
    frame,
    request,
    response,
    body,
    diagnostics,
    observers,
    scope,
    failures,
    cause,
    arm,
    navigate,
    fail,
    report,
    setTime: (value) => {
      time = value;
    },
    reads: () => reads,
  };
}

const processPath =
  "/api/app/workspace/v1/agents/agent/sessions/session/turns/run/process";
function processFixture() {
  const f = fixture();
  const url =
    "http://gateway" + processPath + "?cursor=original-process-cursor";
  f.request.url = () => url;
  f.request.redirectedTo = () => null;
  f.request.failure = () => ({ errorText: "net::ERR_ABORTED" });
  f.response.url = () => url;
  f.response.headers = () => ({
    "content-type": "application/json; charset=utf-8",
  });
  f.terminal = Promise.withResolvers();
  f.requestTerminal = { kind: "failed", failure: "net::ERR_ABORTED", at: 45 };
  f.proof = Object.freeze({
    documentId: "original-document",
    fetchId: "original-document:1",
    method: "GET",
    path: processPath,
    startedAt: 1_790_000_000_000,
    abortedAt: 1_790_000_000_100,
    reasonKind: "default_abort",
  });
  f.matchedRequest = f.request;
  f.matched = [];
  f.cancellation = {
    async flushAndWait() {},
    match(original) {
      f.matched.push(original);
      return original === f.matchedRequest ? f.proof : null;
    },
  };
  f.error = new Error(
    "response.text: Protocol error (Network.getResponseBody): No data found for resource with given identifier",
  );
  f.processReport = () => ({
    agent_id: "agent",
    business_completed: true,
    browser_body_diagnostics: f.diagnostics,
  });
  return f;
}

async function failedProcessRead(f, overrides = {}) {
  const read = f.audit.read(f.page, f.response, "process_complete", {
    terminal: f.terminal.promise,
    cancellation: f.cancellation,
    ...overrides,
  });
  void read.catch(() => {});
  try {
    f.fail(f.error);
    f.setTime(45);
    f.terminal.resolve(f.requestTerminal);
    return await read;
  } finally {
    f.body.resolve("cleanup joins original body");
    f.terminal.resolve(f.requestTerminal);
    await Promise.allSettled([read]);
    for (const observer of f.observers) await observer.closeAndWait();
  }
}

test("C4 records a proved default-aborted process body without requiring login navigation or Trace", async () => {
  const f = processFixture();
  const originalError = {
    name: f.error.name,
    message: f.error.message,
    stack: f.error.stack,
  };
  assert.equal(Object.isFrozen(f.proof), true);
  assert.equal(await failedProcessRead(f), null);
  assert.equal(
    f.reads(),
    1,
    "cancellation cannot replace the original body attempt",
  );
  assert(
    f.matched.length > 0 && f.matched.every((value) => value === f.request),
  );
  assert.equal(f.diagnostics.length, 1);
  const [row] = f.diagnostics;
  assert.equal(row.classification, "cancelled_process_read");
  assert.equal(row.agentId, "agent");
  assert.equal(row.sessionId, "session");
  assert.equal(row.runId, "run");
  assert.equal(row.contentType, "application/json; charset=utf-8");
  assert.equal(row.url, f.response.url());
  assert.equal(row.requestURL, f.request.url());
  assert.equal(row.body, "not_observed");
  assert.deepEqual(row.requestTerminal, f.requestTerminal);
  assert.deepEqual(row.cancellation, f.proof);
  assert.deepEqual(row.raw_error, originalError);
  const report = f.processReport();
  assert.equal(Object.hasOwn(report, "browser_revocation"), false);
  const result = implementation.assertC4BodyDiagnostics(report, {
    gateway: "http://gateway",
  });
  assert.equal(result.body_count, 1);
  assert.deepEqual(result.body_ids, [1]);
});

test("C4 body failure before requestfailed waits for the terminal and late same-Request cancellation proof", async () => {
  const f = processFixture();
  let ended = false,
    proofAvailable = false;
  f.cancellation.match = (original) => {
    f.matched.push(original);
    return proofAvailable && original === f.request ? f.proof : null;
  };
  const read = f.audit.read(f.page, f.response, "process_complete", {
    terminal: f.terminal.promise,
    cancellation: f.cancellation,
  });
  void read.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  try {
    f.fail(f.error);
    await turn();
    assert.equal(
      ended,
      false,
      "body rejection must wait for the original requestfailed",
    );
    assert.deepEqual(f.diagnostics, []);
    proofAvailable = true;
    f.setTime(45);
    f.terminal.resolve(f.requestTerminal);
    assert.equal(await read, null);
    assert.deepEqual(f.diagnostics[0].cancellation, f.proof);
    assert.deepEqual(f.diagnostics[0].requestTerminal, f.requestTerminal);
  } finally {
    f.body.resolve("cleanup joins original body");
    f.terminal.resolve(f.requestTerminal);
    await Promise.allSettled([read]);
    for (const observer of f.observers) await observer.closeAndWait();
  }
});

test("C4 proved requestfailed still joins the original held body before classifying cancellation", async () => {
  const f = processFixture();
  let ended = false;
  const read = f.audit.read(f.page, f.response, "process_complete", {
    terminal: f.terminal.promise,
    cancellation: f.cancellation,
  });
  void read.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  try {
    f.terminal.resolve(f.requestTerminal);
    await turn();
    assert.equal(
      ended,
      false,
      "requestfailed cannot replace joining response.text",
    );
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.diagnostics, []);
    f.fail(f.error);
    assert.equal(await read, null);
    assert.equal(f.diagnostics.length, 1);
  } finally {
    f.body.resolve("cleanup joins original body");
    f.terminal.resolve(f.requestTerminal);
    await Promise.allSettled([read]);
    for (const observer of f.observers) await observer.closeAndWait();
  }
});

test("C4 process cancellation joins the body and terminal before the next business action and never invents a payload read", async () => {
  const f = processFixture();
  const payloads = [],
    actions = [];
  const reader = observeC4Responses(
    f.page,
    f.scope,
    async (value, _url, options) => {
      const text = await f.audit.read(f.page, value, "process_complete", {
        terminal: options?.terminal,
        cancellation: f.cancellation,
      });
      if (text !== null) payloads.push(text);
      actions.push("body joined");
    },
    { now: () => 45 },
  );
  f.page.emit("request", f.request);
  f.page.emit("response", f.response);
  const next = reader.before(() => actions.push("next business action"));
  void next.catch(() => {});
  try {
    f.fail(f.error);
    await turn();
    assert.deepEqual(actions, []);
    assert.equal(reader.ready(), false);
    f.setTime(45);
    f.page.emit("requestfailed", f.request);
    await next;
    assert.deepEqual(actions, ["body joined", "next business action"]);
    assert.deepEqual(
      payloads,
      [],
      "unobserved bodies are not audited payload frames",
    );
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.failures, []);
    assert.equal(f.diagnostics[0].classification, "cancelled_process_read");
  } finally {
    f.body.resolve("cleanup joins original body");
    f.page.emit("requestfailed", f.request);
    await Promise.allSettled([
      next,
      ...f.observers.map((observer) => observer.closeAndWait()),
    ]);
  }
});

for (const [name, change, options] of [
  [
    "missing proof",
    (f) => {
      f.proof = null;
    },
  ],
  [
    "another Request with the same URL",
    (f) => {
      f.matchedRequest = { ...f.request };
    },
  ],
  ["missing cancellation observer", () => {}, { cancellation: undefined }],
  ["missing request terminal", () => {}, { terminal: undefined }],
  [
    "finished request",
    (f) => {
      f.requestTerminal = { kind: "finished", failure: null, at: 45 };
    },
  ],
  [
    "closed page",
    (f) => {
      f.requestTerminal = { kind: "closed", failure: null, at: 45 };
    },
  ],
  [
    "different transport failure",
    (f) => {
      f.requestTerminal.failure = "net::ERR_FAILED";
    },
  ],
  [
    "ambiguous transport failure",
    (f) => {
      f.requestTerminal.failure = "net::ERR_ABORTED or deadline";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.response.url = () =>
        "http://gateway" +
        processPath.replace("/agents/agent/", "/agents/other/");
      f.request.url = f.response.url;
      f.proof = Object.freeze({
        ...f.proof,
        path: new URL(f.response.url()).pathname,
      });
    },
  ],
  [
    "foreign origin",
    (f) => {
      f.response.url = () => "http://other" + processPath;
      f.request.url = f.response.url;
    },
  ],
  [
    "POST",
    (f) => {
      f.request.method = () => "POST";
    },
  ],
  [
    "401",
    (f) => {
      f.response.status = () => 401;
    },
  ],
  [
    "403",
    (f) => {
      f.response.status = () => 403;
    },
  ],
  [
    "non-JSON body",
    (f) => {
      f.response.headers = () => ({ "content-type": "text/html" });
    },
  ],
  [
    "subframe",
    (f) => {
      f.request.frame = () => ({});
    },
  ],
  [
    "redirect source",
    (f) => {
      f.request.redirectedFrom = () => ({});
    },
  ],
  [
    "redirect target",
    (f) => {
      f.request.redirectedTo = () => ({});
    },
  ],
  [
    "another response URL",
    (f) => {
      f.request.url = () => "http://gateway" + processPath + "?cursor=other";
    },
  ],
  [
    "another proof path",
    (f) => {
      f.proof = Object.freeze({
        ...f.proof,
        path: processPath.replace("/run/", "/other/"),
      });
    },
  ],
  ...["deadline", "session_changed", "unknown"].map((reasonKind) => [
    reasonKind,
    (f) => {
      f.proof = Object.freeze({ ...f.proof, reasonKind });
    },
  ]),
  ...[30_000, 30_001, Infinity, -1].map((duration) => [
    `invalid cancellation duration ${duration}`,
    (f) => {
      f.proof = Object.freeze({
        ...f.proof,
        abortedAt: f.proof.startedAt + duration,
      });
    },
  ]),
])
  test(`C4 process body remains blocking for ${name}`, async () => {
    const f = processFixture();
    change(f);
    await assert.rejects(
      failedProcessRead(f, options),
      (error) => error === f.error,
    );
    assert.deepEqual(f.diagnostics, []);
  });

for (const [name, change] of [
  [
    "unfinished business",
    (report) => {
      report.business_completed = false;
    },
  ],
  [
    "unrecognized classification",
    (report, row) => {
      row.classification = "unknown";
    },
  ],
  [
    "another report Agent",
    (report) => {
      report.agent_id = "other";
    },
  ],
  [
    "another row Agent",
    (report, row) => {
      row.agentId = "other";
    },
  ],
  [
    "another Session",
    (report, row) => {
      row.sessionId = "other";
    },
  ],
  [
    "another Run",
    (report, row) => {
      row.runId = "other";
    },
  ],
  [
    "missing original error",
    (report, row) => {
      delete row.raw_error;
    },
  ],
  [
    "missing cancellation proof",
    (report, row) => {
      delete row.cancellation;
    },
  ],
  [
    "changed proof path",
    (report, row) => {
      row.cancellation.path = processPath.replace("/run/", "/other/");
    },
  ],
  [
    "changed proof method",
    (report, row) => {
      row.cancellation.method = "POST";
    },
  ],
  [
    "application deadline",
    (report, row) => {
      row.cancellation.reasonKind = "deadline";
    },
  ],
  [
    "thirty-second cancellation",
    (report, row) => {
      row.cancellation.abortedAt = row.cancellation.startedAt + 30_000;
    },
  ],
  [
    "finished request",
    (report, row) => {
      row.requestTerminal.kind = "finished";
      row.requestTerminal.failure = null;
    },
  ],
  [
    "different request failure",
    (report, row) => {
      row.requestTerminal.failure = "net::ERR_FAILED";
    },
  ],
  [
    "missing terminal",
    (report, row) => {
      delete row.requestTerminal;
    },
  ],
  [
    "non-JSON response",
    (report, row) => {
      row.contentType = "text/plain";
    },
  ],
  [
    "forbidden response",
    (report, row) => {
      row.status = 403;
    },
  ],
  [
    "POST response",
    (report, row) => {
      row.method = "POST";
    },
  ],
  [
    "redirect",
    (report, row) => {
      row.redirected = true;
    },
  ],
  [
    "subframe",
    (report, row) => {
      row.mainFrame = false;
    },
  ],
  [
    "changed request URL",
    (report, row) => {
      row.requestURL += "&other=1";
    },
  ],
])
  test(`C4 final cancelled-process diagnostic review rejects ${name}`, async () => {
    const f = processFixture();
    assert.equal(await failedProcessRead(f), null);
    const report = structuredClone(f.processReport());
    change(report, report.browser_body_diagnostics[0]);
    assert.throws(() =>
      implementation.assertC4BodyDiagnostics(report, {
        gateway: "http://gateway",
      }),
    );
  });

for (const status of [200, 401, 403])
  for (const route of ["view", "bootstrap"])
    for (const pending of [true, false]) {
      test(`C4 retains unavailable ${route} ${status} body crossing verified login navigation (${pending ? "pending" : "new"} read)`, async () => {
        const f = fixture(status, route);
        if (!pending) f.arm();
        const read = f.audit.read(
          f.page,
          f.response,
          "mobile_layout_input_completion",
        );
        if (pending) f.arm();
        f.navigate();
        f.fail();
        assert.equal(await read, null);
        assert.equal(f.reads(), 1);
        assert.equal(f.diagnostics.length, 1);
        assert.equal(f.diagnostics[0].status, status);
        assert.equal(f.diagnostics[0].body, "not_observed");
        assert.match(
          f.diagnostics[0].raw_error.message,
          /Network.getResponseBody/,
        );
        const result = implementation.assertC4BodyDiagnostics(f.report(), {
          gateway: "http://gateway",
        });
        assert.deepEqual(result, {
          status: "accepted_external_observation",
          body_count: 1,
          body_ids: [1],
        });
      });
    }

test("C4 keeps readable bodies in the payload audit and snapshots metadata before the read", async () => {
  const f = fixture();
  const read = f.audit.read(f.page, f.response, "mobile");
  f.arm();
  f.navigate();
  f.body.resolve("private runtime data must still be scanned");
  assert.equal(await read, "private runtime data must still be scanned");
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.diagnostics, []);
  const g = fixture(403);
  const missing = g.audit.read(g.page, g.response, "mobile");
  g.response.status = () => 500;
  g.response.headers = () => ({});
  g.arm();
  g.navigate();
  g.fail();
  assert.equal(await missing, null);
  assert.equal(g.diagnostics[0].status, 403);
  assert.equal(g.diagnostics[0].traceID, "a".repeat(32));
});

for (const [name, change] of [
  [
    "server error",
    (f) => {
      f.response.status = () => 500;
    },
  ],
  [
    "unknown status",
    (f) => {
      f.response.status = () => undefined;
    },
  ],
  [
    "other success",
    (f) => {
      f.response.status = () => 204;
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.response.url = () =>
        "http://gateway/api/app/workspace/v1/agents/other/view?sessionId=session";
      f.request.url = f.response.url;
    },
  ],
  [
    "foreign Session",
    (f) => {
      f.response.url = () =>
        "http://gateway/api/app/workspace/v1/agents/agent/view?sessionId=other";
      f.request.url = f.response.url;
    },
  ],
  [
    "duplicate Session",
    (f) => {
      f.response.url = () =>
        "http://gateway/api/app/workspace/v1/agents/agent/view?sessionId=session&sessionId=session";
      f.request.url = f.response.url;
    },
  ],
  [
    "extra query",
    (f) => {
      f.response.url = () =>
        "http://gateway/api/app/workspace/v1/agents/agent/view?sessionId=session&x=1";
      f.request.url = f.response.url;
    },
  ],
  [
    "foreign origin",
    (f) => {
      f.response.url = () =>
        "http://other/api/app/workspace/v1/agents/agent/view?sessionId=session";
      f.request.url = f.response.url;
    },
  ],
  [
    "other route",
    (f) => {
      f.response.url = () => "http://gateway/api/app/workspace/v1/agents";
      f.request.url = f.response.url;
    },
  ],
  [
    "bootstrap query",
    (f) => {
      f.response.url = () =>
        "http://gateway/api/app/workspace/v1/bootstrap?x=1";
      f.request.url = f.response.url;
    },
  ],
  [
    "subframe",
    (f) => {
      f.request.frame = () => ({});
    },
  ],
  [
    "redirect",
    (f) => {
      f.request.redirectedFrom = () => ({});
    },
  ],
  [
    "wrong method",
    (f) => {
      f.request.method = () => "POST";
    },
  ],
  [
    "different request URL",
    (f) => {
      f.request.url = () => "http://gateway/elsewhere";
    },
  ],
  [
    "missing Trace",
    (f) => {
      f.response.headers = () => ({});
    },
  ],
  [
    "zero Trace",
    (f) => {
      f.response.headers = () => ({ "x-antnest-trace-id": "0".repeat(32) });
    },
  ],
])
  test(`C4 does not classify ${name} as auth-navigation body unavailability`, async () => {
    const f = fixture();
    change(f);
    const read = f.audit.read(f.page, f.response, "mobile");
    f.arm();
    f.navigate();
    const error = unavailable();
    f.fail(error);
    await assert.rejects(read, (e) => e === error);
    assert.deepEqual(f.diagnostics, []);
  });

for (const mode of [
  "unarmed",
  "no-navigation",
  "manual",
  "foreign-login",
  "intervening-document",
  "late-read",
  "unknown-error",
]) {
  test(`C4 body unavailability remains blocking for ${mode}`, async () => {
    const f = fixture();
    let read;
    if (mode !== "late-read") read = f.audit.read(f.page, f.response, "mobile");
    if (mode !== "unarmed") f.arm();
    if (mode === "manual")
      await f.audit.beforeChange(f.page, async () => f.navigate());
    else if (mode === "foreign-login") f.navigate("http://other/");
    else if (mode === "intervening-document") {
      f.navigate("http://gateway/elsewhere");
      f.navigate();
    } else if (mode !== "no-navigation") f.navigate();
    if (mode === "late-read") read = f.audit.read(f.page, f.response, "mobile");
    const error =
      mode === "unknown-error"
        ? new Error("ordinary response read failure")
        : unavailable();
    f.fail(error);
    await assert.rejects(read, (e) => e === error);
    assert.deepEqual(f.diagnostics, []);
  });
}

for (const query of [
  "return_to=%2Fworkspace%2Fother%2Fsessions%2Fsession",
  "return_to=%2Fworkspace%2Fagent%2Fsessions%2Fother",
  "return_to=https%3A%2F%2Fother%2Fworkspace%2Fagent%2Fsessions%2Fsession",
  "return_to=%2Fworkspace%2Fagent%2Fsessions%2Fsession&return_to=%2Fworkspace%2Fagent%2Fsessions%2Fsession",
  "return_to=%2Fworkspace%2Fagent%2Fsessions%2Fsession&extra=1",
  "return_to=%2Fworkspace%2Fagent%2Fsessions%2Fsession%3Fx%3D1",
])
  test(`C4 login navigation rejects a foreign or ambiguous return target: ${query}`, async () => {
    const f = fixture();
    const read = f.audit.read(f.page, f.response, "mobile");
    f.arm();
    f.navigate("http://gateway/?" + query);
    const error = unavailable();
    f.fail(error);
    await assert.rejects(read, (e) => e === error);
  });

test("C4 pending diagnostics do not poison finite-reader joins, while a second ordinary error still blocks", async () => {
  const f = fixture();
  const reader = observeC4Responses(f.page, f.scope, (response) =>
    f.audit.read(f.page, response, "mobile"),
  );
  f.page.emit("request", f.response.request());
  f.page.emit("response", f.response);
  f.arm();
  f.navigate();
  f.fail();
  f.page.emit("requestfinished", f.response.request());
  await reader.wait();
  assert(reader.ready());
  assert.deepEqual(f.failures, []);
  const original = new Error("independent body failure");
  const nextRequest = { ...f.response.request() };
  f.page.emit("request", nextRequest);
  f.page.emit("response", {
    ...f.response,
    request: () => nextRequest,
    text: async () => {
      throw original;
    },
  });
  f.page.emit("requestfinished", nextRequest);
  await assert.rejects(reader.wait(), (e) => e === original);
  assert(f.failures.includes(original));
  for (const observer of f.observers)
    await observer.closeAndWait().catch(() => {});
  assert.equal(f.page.listenerCount("framenavigated"), 0);
  assert.equal(f.page.listenerCount("response"), 0);
});

for (const [name, change] of [
  [
    "incomplete business",
    (r) => {
      r.business_completed = false;
    },
  ],
  [
    "missing proof",
    (r) => {
      delete r.browser_revocation.bodyObservation;
    },
  ],
  [
    "failed deactivation",
    (r) => {
      r.browser_revocation.cause.status = 500;
    },
  ],
  [
    "foreign cause",
    (r) => {
      r.browser_revocation.cause.startedMono++;
    },
  ],
  [
    "foreign page",
    (r) => {
      r.browser_revocation.bodyObservation.pageId++;
    },
  ],
  [
    "foreign Session",
    (r) => {
      r.browser_revocation.selectedView.sessionId = "other";
    },
  ],
  [
    "visible messages",
    (r) => {
      r.browser_revocation.bodyObservation.messageCount = 1;
    },
  ],
  [
    "missing login",
    (r) => {
      r.browser_revocation.bodyObservation.signInVisible = false;
    },
  ],
])
  test(`C4 final body diagnostic review rejects ${name}`, async () => {
    const f = fixture();
    const read = f.audit.read(f.page, f.response, "mobile");
    f.arm();
    f.navigate();
    f.fail();
    await read;
    const report = f.report();
    change(report);
    assert.throws(() =>
      implementation.assertC4BodyDiagnostics(report, {
        gateway: "http://gateway",
      }),
    );
  });
