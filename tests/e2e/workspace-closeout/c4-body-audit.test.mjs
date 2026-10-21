import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
    reads: () => reads,
  };
}

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
  f.page.emit("response", f.response);
  f.arm();
  f.navigate();
  f.fail();
  await reader.wait();
  assert(reader.ready());
  assert.deepEqual(f.failures, []);
  const original = new Error("independent body failure");
  f.page.emit("response", {
    ...f.response,
    text: async () => {
      throw original;
    },
  });
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
