import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";

const url = new URL("./session-fault-lifecycle.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const principal = { organization_id: "organization", user_id: "user" };
const project = "antnest-stage3-e2e-1234";
const runID = "00000000-0000-4000-8000-000000000001";
const scope = "00000000-0000-4000-8000-000000000002";

test("Session cleanup drains transports, then database and telemetry", async () => {
  assert.equal(typeof implementation.closeSessionFaultResources, "function");
  const calls = [];
  await implementation.closeSessionFaultResources({
    clients: [
      {
        async closeAndWait() {
          await delay(1);
          calls.push("client");
        },
      },
    ],
    observers: [
      {
        async closeAndWait() {
          calls.push("observer");
        },
      },
    ],
    pool: {
      async end() {
        assert(calls.includes("client") && calls.includes("observer"));
        calls.push("pool");
      },
    },
    telemetry: {
      async shutdown() {
        assert.equal(calls.at(-1), "pool");
        calls.push("telemetry");
      },
    },
  });
  assert.equal(calls.at(-1), "telemetry");
});

test("Session cleanup joins every resource despite synchronous, transport, database and telemetry failures", async () => {
  assert.equal(typeof implementation.closeSessionFaultResources, "function");
  const clientDone = Promise.withResolvers(),
    telemetryDone = Promise.withResolvers();
  const failures = ["client", "observer", "pool", "telemetry"].map(
    (name) => new Error(name),
  );
  const calls = [];
  let settled = false;
  const result = implementation
    .closeSessionFaultResources({
      clients: [
        {
          async closeAndWait() {
            calls.push("client-start");
            await clientDone.promise;
            calls.push("client-end");
          },
        },
        {
          closeAndWait() {
            calls.push("client-failed");
            throw failures[0];
          },
        },
      ],
      observers: [
        {
          async closeAndWait() {
            calls.push("observer-failed");
            throw failures[1];
          },
        },
      ],
      pool: {
        async end() {
          assert(calls.includes("client-end"));
          calls.push("pool-failed");
          throw failures[2];
        },
      },
      telemetry: {
        async shutdown() {
          assert(calls.includes("pool-failed"));
          calls.push("telemetry-start");
          await telemetryDone.promise;
          calls.push("telemetry-end");
          throw failures[3];
        },
      },
    })
    .then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
  await delay(1);
  assert(calls.includes("client-failed") && calls.includes("observer-failed"));
  assert(!calls.includes("pool-failed"));
  assert.equal(settled, false);
  clientDone.resolve();
  await delay(1);
  assert(calls.includes("telemetry-start"));
  assert.equal(settled, false);
  telemetryDone.resolve();
  const error = await result;
  assert(error instanceof AggregateError);
  assert.deepEqual(new Set(error.errors), new Set(failures));
  assert.equal(calls.at(-1), "telemetry-end");
});

async function respond(directory, step, expected, change = () => {}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let request;
    try {
      request = JSON.parse(
        await readFile(join(directory, `request-${step}`), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(5);
      continue;
    }
    const reply = { ...expected, request };
    change(reply);
    await writeFile(join(directory, `done-${step}`), JSON.stringify(reply));
    return reply;
  }
  throw new Error("fixture did not receive current checkpoint request");
}

function fault(reason = "revoked") {
  const calls = [],
    joined = Promise.withResolvers();
  const checkpoint = {
    reason,
    expiresAt: 5000,
    stream: { credential_scope: scope, started_at: 1000, headers_at: 1200 },
    issuance: { startedMono: 700, completedMono: 900, traceID: "d".repeat(32) },
  };
  const closure = {
    transport: "http-sse",
    traceID: "a".repeat(32),
    credentialScope: scope,
    reason,
    checkpoint,
    localClose: false,
    silent: true,
    authorizationCauseVerified: false,
  };
  const observer = {
    principal,
    async waitForClose(point) {
      assert.equal(point, checkpoint);
      calls.push("remote-close");
      return closure;
    },
    async rejectPrompt() {
      calls.push("http-denial");
      return { traceID: "b".repeat(32), credentialScope: scope };
    },
    async closeAndWait() {
      calls.push("observer-joined");
    },
  };
  const client = {
    version: 2,
    async closeAndWait() {
      calls.push("sdk-joined");
      joined.resolve({ rejected: true });
    },
  };
  const causes = {
    revoked: {
      kind: "logout",
      credentialScope: scope,
      principal,
      traceID: "c".repeat(32),
    },
    unavailable: {
      kind: "identity-outage",
      transition: { deployment: { step: 1 } },
    },
    expired: {
      kind: "absolute-expiry",
      expiresAt: 5000,
      transition: {
        deployment: { step: 2, after: { token_ttl: "5s" } },
        observation: { acknowledged: { at: 600 } },
      },
    },
  };
  let now = 4500;
  return {
    calls,
    checkpoint,
    closure,
    observer,
    client,
    pending: joined.promise,
    cause: causes[reason],
    now: () => now,
    async wait(ms) {
      calls.push("expiry-wait");
      now += ms;
    },
  };
}

for (const reason of ["revoked", "unavailable", "expired"])
  test(`Session ${reason} observes remote SSE close before HTTP denial and joins private SDK cleanup`, async () => {
    assert.equal(typeof implementation.finishSessionFault, "function");
    const f = fault(reason);
    const result = await implementation.finishSessionFault(f);
    f.calls.push("model-release");
    assert.deepEqual(f.calls, [
      "remote-close",
      ...(reason === "expired" ? ["expiry-wait"] : []),
      "http-denial",
      "sdk-joined",
      "observer-joined",
      "model-release",
    ]);
    assert.equal(result.authorizationCauseVerified, false);
    assert.equal(result.protocolVersion, 2);
    assert.equal(result.protocolClientClosedLocally, true);
    assert.equal(result.localClose, false);
    assert.equal(result.cause, f.cause);
    assert.equal(result.denial.traceID, "b".repeat(32));
    assert.deepEqual(result.principal, principal);
  });

test("an already elapsed absolute deadline needs no further expiry wait", async () => {
  assert.equal(typeof implementation.finishSessionFault, "function");
  const f = fault("expired");
  f.now = () => 18201;
  await implementation.finishSessionFault(f);
  assert(!f.calls.includes("expiry-wait"));
});

test("expiry waits for the fixed original monotonic authority and cache bound", async () => {
  const f = fault("expired");
  let elapsed = 6000,
    waited;
  f.now = () => elapsed;
  f.wait = async (milliseconds) => {
    waited = milliseconds;
    elapsed += milliseconds;
  };
  await implementation.finishSessionFault(f);
  assert.equal(waited, 12201);
  assert.equal(f.calls.filter((call) => call === "http-denial").length, 1);
});

test("expiry cancellation joins both transports and never dispatches the HTTP probe", async () => {
  const f = fault("expired"),
    controller = new AbortController(),
    reason = new Error("cancel expiry wait");
  f.signal = controller.signal;
  f.wait = async (_ms, _value, options) => {
    controller.abort(reason);
    options.signal.throwIfAborted();
  };
  await assert.rejects(
    () => implementation.finishSessionFault(f),
    (error) => error === reason,
  );
  assert(!f.calls.includes("http-denial"));
  assert(f.calls.includes("sdk-joined") && f.calls.includes("observer-joined"));
});

for (const [name, change] of [
  ["missing actual short-TTL deployment", (f) => delete f.cause.transition],
  [
    "wrong actual token TTL",
    (f) => (f.cause.transition.deployment.after.token_ttl = "12h"),
  ],
  [
    "login before rebuild acknowledgement",
    (f) => (f.checkpoint.issuance.startedMono = 500),
  ],
  [
    "missing original header timestamp",
    (f) => delete f.checkpoint.stream.headers_at,
  ],
  [
    "wait that did not reach the fixed deadline",
    (f) => (f.wait = async () => {}),
  ],
])
  test(`expiry refuses ${name}`, async () => {
    const f = fault("expired");
    change(f);
    await assert.rejects(() => implementation.finishSessionFault(f));
    assert(!f.calls.includes("http-denial"));
  });

for (const stage of ["waitForClose", "rejectPrompt"])
  test(`Session cleanup joins both transports after ${stage} fails without hiding that failure`, async () => {
    assert.equal(typeof implementation.finishSessionFault, "function");
    const f = fault(),
      failure = new Error("original failure");
    f.observer[stage] = async () => {
      throw failure;
    };
    await assert.rejects(
      () => implementation.finishSessionFault(f),
      (error) => error === failure,
    );
    assert(f.calls.includes("sdk-joined"));
    assert(f.calls.includes("observer-joined"));
  });

test("failed cleanup cannot report the Session fault as passed", async () => {
  assert.equal(typeof implementation.finishSessionFault, "function");
  const f = fault();
  delete f.pending;
  f.client.closeAndWait = async () => {
    throw new Error("not joined");
  };
  await assert.rejects(() => implementation.finishSessionFault(f));
  assert(f.calls.includes("observer-joined"));
});

test("an already rejected SDK request is observed while the remote close remains pending", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { setTimeout as delay } from 'node:timers/promises';
    import { finishSessionFault } from ${JSON.stringify(url.href)};
    const checkpoint={reason:'expired',expiresAt:1,stream:{credential_scope:'scope',started_at:200,headers_at:300},issuance:{startedMono:100,completedMono:150}};
    const observer={
      principal:{organization_id:'org',user_id:'user'},
      async waitForClose(){await delay(30);return {transport:'http-sse',localClose:false,authorizationCauseVerified:false,credentialScope:'scope'};},
      async rejectPrompt(){return {credentialScope:'scope',traceID:'b'.repeat(32)};},
      async closeAndWait(){}
    };
    await assert.rejects(finishSessionFault({observer,client:{version:1,async closeAndWait(){}},checkpoint,
      cause:{kind:'absolute-expiry',expiresAt:1,transition:{deployment:{step:2,after:{token_ttl:'5s'}},observation:{acknowledged:{at:90}}}},
      now:()=>20000,pending:Promise.reject(new Error('SDK closed'))}));
  `,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, change] of [
  [
    "different cause",
    (f) => {
      f.cause.kind = "absolute-expiry";
    },
  ],
  [
    "different logout authority",
    (f) => {
      f.cause.credentialScope = "foreign";
    },
  ],
  [
    "local stream close",
    (f) => {
      f.closure.localClose = true;
    },
  ],
  [
    "foreign denial authority",
    (f) => {
      f.observer.rejectPrompt = async () => ({ credentialScope: "foreign" });
    },
  ],
])
  test(`Session cannot accept ${name}`, async () => {
    assert.equal(typeof implementation.finishSessionFault, "function");
    const f = fault();
    change(f);
    await assert.rejects(() => implementation.finishSessionFault(f));
  });

test("logout records the actual HTTP trace and original authority without retaining Cookies", async () => {
  assert.equal(typeof implementation.logoutSession, "function");
  const f = fault();
  const browser = {
    cookie: "PRIVATE-COOKIE",
    async request(path, options) {
      assert.equal(this.cookie, "PRIVATE-COOKIE");
      assert.equal(path, "/api/session");
      assert.equal(options.method, "DELETE");
      this.cookie = "";
      return {
        status: 204,
        traceID: "c".repeat(32),
        headers: new Headers({
          "cache-control": "no-store",
          "set-cookie": "antnest_session=; Max-Age=0; Path=/",
        }),
      };
    },
  };
  const original = browser.request;
  browser.request = async function (...args) {
    const response = await original.apply(this, args);
    response.headers.append("set-cookie", "antnest_csrf=; Max-Age=0; Path=/");
    return response;
  };
  f.observer.browser = { cookie: browser.cookie };
  const result = await implementation.logoutSession(
    browser,
    f.observer,
    f.checkpoint,
    principal,
  );
  assert.equal(result.traceID, "c".repeat(32));
  assert.equal(result.credentialScope, scope);
  assert.deepEqual(result.principal, principal);
  assert.equal(result.status, 204);
  assert(!JSON.stringify(result).includes("PRIVATE-COOKIE"));
  assert(result.completedAt >= result.startedAt);
});

for (const mode of ["trace", "cookie"])
  test(`logout ${mode} contract failure cannot disclose a credential canary`, async () => {
    const canary = "PRIVATE-LOGOUT-CREDENTIAL-CANARY";
    const f = fault();
    const browser = {
      cookie: "original",
      async request() {
        this.cookie = mode === "cookie" ? canary : "";
        const headers = new Headers({ "cache-control": "no-store" });
        headers.append("set-cookie", "antnest_session=; Max-Age=0; Path=/");
        headers.append("set-cookie", "antnest_csrf=; Max-Age=0; Path=/");
        return {
          status: 204,
          traceID: mode === "trace" ? canary : "c".repeat(32),
          headers,
        };
      },
    };
    f.observer.browser = { cookie: "original" };
    await assert.rejects(
      () =>
        implementation.logoutSession(
          browser,
          f.observer,
          f.checkpoint,
          principal,
        ),
      (error) => {
        assert(!inspect(error).includes(canary));
        return true;
      },
    );
  });

function receipt(step, previous) {
  const before = previous?.after ?? {
    container_id: "a".repeat(64),
    token_ttl: "12h",
    running: true,
    started_at: "2026-10-15T01:00:00Z",
    finished_at: "0001-01-01T00:00:00Z",
  };
  const after =
    step === 1
      ? { ...before, running: false, finished_at: "2026-10-15T01:00:01Z" }
      : {
          container_id: (step === 2 ? "b" : "c").repeat(64),
          token_ttl: step === 2 ? "5s" : "12h",
          running: true,
          started_at: `2026-10-15T01:00:0${step}Z`,
          finished_at: "0001-01-01T00:00:00Z",
        };
  return {
    version: 1,
    project,
    run_id: runID,
    step,
    image_ref: `antnest/identity-service:session-${runID}`,
    image_id: "sha256:" + "d".repeat(64),
    before,
    after,
    authorization_cause_verified: false,
    command_observation: {
      clock: "runner-wall",
      started_at_ms: step * 1000,
      returned_at_ms: step * 1000 + 100,
    },
    raw: { before_sha256: "e".repeat(64), after_sha256: "f".repeat(64) },
  };
}

test("actual checkpoint files bind all three Identity transitions to the run and preserve clock domains", async (t) => {
  assert.equal(
    typeof implementation.requestIdentitySessionTransition,
    "function",
  );
  const directory = await mkdtemp(join(tmpdir(), "antnest-session-fault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let previous;
  for (const step of [1, 2, 3]) {
    const expected = receipt(step, previous?.deployment);
    const reply = respond(directory, step, expected);
    const result = await implementation.requestIdentitySessionTransition(
      step,
      previous,
      { directory, project, runID },
    );
    assert.deepEqual(result.deployment, await reply);
    assert.equal(result.observation.clock, "session-client");
    assert(
      result.observation.acknowledged.at >= result.observation.requested.at,
    );
    const sent = JSON.parse(
      await readFile(join(directory, `request-${step}`), "utf8"),
    );
    assert.equal(sent.run_id, runID);
    assert.equal(sent.step, step);
    assert.match(sent.nonce ?? "", /^[a-f0-9-]{36}$/u);
    assert.deepEqual(result.deployment.request, sent);
    previous = result;
  }
});

for (const [name, change] of [
  [
    "wrong project",
    (r) => {
      r.project = "foreign";
    },
  ],
  [
    "wrong run",
    (r) => {
      r.run_id = "foreign";
    },
  ],
  [
    "wrong step",
    (r) => {
      r.step = 2;
    },
  ],
  [
    "wrong candidate",
    (r) => {
      r.image_ref = "antnest/identity-service:local";
    },
  ],
  [
    "missing raw",
    (r) => {
      delete r.raw;
    },
  ],
  [
    "claimed authorization cause",
    (r) => {
      r.authorization_cause_verified = true;
    },
  ],
  [
    "wrong stopped state",
    (r) => {
      r.after.running = true;
    },
  ],
])
  test(`Identity acknowledgement rejects ${name}`, async (t) => {
    assert.equal(
      typeof implementation.requestIdentitySessionTransition,
      "function",
    );
    const directory = await mkdtemp(join(tmpdir(), "antnest-session-fault-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const expected = receipt(1);
    change(expected);
    const reply = respond(directory, 1, expected);
    await assert.rejects(() =>
      implementation.requestIdentitySessionTransition(1, undefined, {
        directory,
        project,
        runID,
      }),
    );
    await reply;
  });

test("a pre-existing acknowledgement is rejected before a new fault request is published", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "antnest-session-fault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "done-1"), JSON.stringify(receipt(1)));
  await assert.rejects(() =>
    implementation.requestIdentitySessionTransition(1, undefined, {
      directory,
      project,
      runID,
    }),
  );
  await assert.rejects(readFile(join(directory, "request-1")), {
    code: "ENOENT",
  });
});

test("an acknowledgement for another request nonce cannot complete this fault", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "antnest-session-fault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reply = respond(directory, 1, receipt(1), (row) => {
    row.request.nonce = scope;
  });
  await assert.rejects(() =>
    implementation.requestIdentitySessionTransition(1, undefined, {
      directory,
      project,
      runID,
    }),
  );
  await reply;
});

for (const mode of ["cancelled", "late"])
  test(`a ${mode} ACK read cannot turn the checkpoint into success`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "antnest-session-fault-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const controller = new AbortController();
    let at = 0;
    const reply = respond(directory, 1, receipt(1));
    await assert.rejects(() =>
      implementation.requestIdentitySessionTransition(1, undefined, {
        directory,
        project,
        runID,
        signal: controller.signal,
        observe: () => ({ at, observed_at_ms: 1000 + at }),
        async read(...args) {
          const value = await readFile(...args);
          if (mode === "cancelled") controller.abort();
          else at = 90001;
          return value;
        },
      }),
    );
    await reply;
  });
