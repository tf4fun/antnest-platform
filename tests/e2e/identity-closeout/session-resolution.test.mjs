import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import {
  resolutionFixture,
  sharedResolutionFixture,
  resolvePrefix,
  sourceID,
  triggerID,
  setTag,
  addResolveRPC,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields, databaseRequest } from "../observability/trace-fixtures.mjs";
import {
  inspectSessionClosure,
  collectSessionClosure,
} from "./session-trace.mjs";
import { verifyIdentityEvidence } from "./trace.mjs";
import {
  verifyIdentityTraces,
  inspectIdentityTraceTopology,
} from "./support.mjs";

function fixture(source = "cache") {
  const f = source.startsWith("shared")
    ? sharedResolutionFixture(source === "shared-background")
    : resolutionFixture(source);
  for (const trace of f.traces.values())
    for (const span of trace.spans)
      if (span.tags.some((field) => field.key === resolvePrefix + "profile"))
        setTag(span, resolvePrefix + "profile", "acp");
  setTag(f.root, "http.route", "/api/app/agents/{agent_id}/v2/acp");
  setTag(f.root, "http.response.status_code", 101);
  f.trace.processes.acp = { serviceName: "agent-acp-service" };
  f.trace.spans.push({
    traceID: f.trace.traceID,
    spanID: "socket-server",
    processID: "acp",
    operationName: "HTTP GET /v2/acp",
    startTime: f.upstream.startTime + 100,
    duration: 5000,
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.upstream.spanID,
      },
    ],
    tags: fields({
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/v2/acp",
      "http.response.status_code": 101,
    }),
  });
  f.expected = {
    connectionTraceID: f.trace.traceID,
    version: 2,
    reason: "revoked",
    closeCode: 1008,
    closeReason: "session_rejected",
    localClose: false,
    postCloseRequestSent: false,
    startedAt: 100,
    closedAt: 500,
    requestCount: 2,
  };
  return f;
}

async function directory(t) {
  const path = await mkdtemp(join(temporaryStorageRoot(), "identity-resolve-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

for (const source of ["rpc", "cache", "shared", "shared-background"])
  test(`silent closure proves actual ${source} admission before the socket dial`, () => {
    const f = fixture(source),
      before = JSON.stringify([...f.traces]);
    const result = inspectSessionClosure(f.trace, f.expected, [], f);
    assert.equal(
      result.gateway_resolution.source,
      source.startsWith("shared") ? "shared" : source,
    );
    assert.equal(result.gateway_resolution.admission, true);
    assert.equal(result.identity_sql, source === "cache" ? 0 : 1);
    assert.equal(result.strict_trace, "passed");
    assert.equal(JSON.stringify([...f.traces]), before);
  });

for (const [name, mutate] of [
  [
    "missing decision",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.decision), 1),
  ],
  [
    "wrong profile",
    (f) => setTag(f.decision, resolvePrefix + "profile", "workspace"),
  ],
  [
    "missing cache budget",
    (f) => setTag(f.decision, resolvePrefix + "proof_age_ms", undefined),
  ],
  [
    "expired budget",
    (f) => setTag(f.decision, resolvePrefix + "valid_for_ms", 0),
  ],
  ["decision after dial", (f) => (f.decision.startTime = f.upstream.startTime)],
  [
    "duplicate initial decision",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.decision),
        spanID: "extra-decision",
      }),
  ],
  ["detached decision", (f) => (f.decision.references = [])],
])
  test(`closure rejects ${name} even with a real successful Resolve RPC`, () => {
    const f = fixture("rpc");
    if (["missing cache budget", "expired budget"].includes(name)) {
      setTag(f.decision, resolvePrefix + "source", "cache");
      for (const [key, value] of Object.entries({
        snapshot_age_ms: 0,
        proof_age_ms: 0,
        valid_for_ms: 10000,
      }))
        setTag(f.decision, resolvePrefix + key, value);
    }
    mutate(f);
    assert.throws(() => inspectSessionClosure(f.trace, f.expected, [], f));
  });

for (const [name, mutate, pattern] of [
  ["unarchived source", (f) => f.archivedTraceIDs.delete(sourceID), /archiv/],
  ["missing source SQL", (f) => f.origin.trace.spans.pop(), /PostgreSQL/],
  ["missing source parent", (f) => f.origin.trace.spans.shift(), /parent/],
  [
    "source secret",
    (f) => setTag(f.origin.root, "private", "private-source-canary"),
    /secret/,
  ],
  [
    "trigger secret",
    (f) =>
      setTag(
        f.traces.get(triggerID).spans[0],
        "private",
        "private-source-canary",
      ),
    /secret/,
  ],
])
  test(`closure rejects ${name}`, () => {
    const f = fixture("shared-background");
    mutate(f);
    assert.throws(
      () =>
        inspectSessionClosure(
          f.trace,
          f.expected,
          ["private-source-canary"],
          f,
        ),
      pattern,
    );
  });

test("source and trigger warnings and errors keep the separate strict gate failed", () => {
  const f = fixture("shared-background");
  f.origin.root.warnings = ["clock skew adjustment disabled; source"];
  setTag(f.traces.get(triggerID).spans[0], "error", true);
  const result = inspectSessionClosure(f.trace, f.expected, [], f);
  assert.equal(result.warning_count, 1);
  assert.equal(result.error_spans, 1);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(result.source_trace_ids, [sourceID, triggerID]);
});

test("closure collection waits for complete source SQL and archives both real traces", async (t) => {
  const f = fixture("shared"),
    output = await directory(t);
  let samples = 0,
    queries = 0;
  const result = await collectSessionClosure("http://jaeger", f.expected, [], {
    directory: output,
    attempts: 5,
    wait: async () => {},
    request: async (url) => {
      queries++;
      const id = url.split("/").at(-1),
        trace = structuredClone(f.traces.get(id));
      if (id === sourceID && ++samples <= 2) trace.spans.pop();
      return Response.json({ data: [trace] });
    },
  });
  assert.equal(samples, 5);
  assert.equal(queries, 10);
  assert.equal(result.gateway_resolution.source, "shared");
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(await readFile(join(output, id + ".json"), "utf8")),
      trace,
    );
});

test("late source diagnostics reset convergence even when span IDs stay unchanged", async (t) => {
  const f = fixture("shared"),
    output = await directory(t);
  let samples = 0;
  const result = await collectSessionClosure("http://jaeger", f.expected, [], {
    directory: output,
    attempts: 5,
    wait: async () => {},
    request: async (url) => {
      const id = url.split("/").at(-1),
        trace = structuredClone(f.traces.get(id));
      if (id === sourceID && ++samples >= 3)
        trace.spans[0].warnings = ["late source warning"];
      return Response.json({ data: [trace] });
    },
  });
  assert.equal(samples, 5);
  assert.equal(result.warning_count, 1);
  assert.equal(result.strict_trace, "failed");
});

function businessFixture(source = "shared-background") {
  const f = fixture(source);
  for (const trace of f.traces.values())
    for (const span of trace.spans)
      if (span.tags.some((field) => field.key === resolvePrefix + "profile"))
        setTag(span, resolvePrefix + "profile", "session");
  setTag(f.root, "http.route", "/api/session/password");
  setTag(f.root, "http.request.method", "POST");
  setTag(f.root, "http.response.status_code", 200);
  f.trace.spans = f.trace.spans.filter(
    (span) => span.spanID !== "socket-server",
  );
  setTag(f.upstream, "http.request.method", "POST");
  f.trace.spans.push(
    ...databaseRequest(
      f.trace.traceID,
      "business",
      f.upstream.spanID,
      "identity",
      "/rpc/identity/change-local-password",
      "POST",
      "change_local_password",
    ),
  );
  f.business = {
    traceID: f.trace.traceID,
    method: "POST",
    route: "/rpc/identity/change-local-password",
    rpcMethod: "change_local_password",
    resolveProfile: "session",
  };
  return f;
}

for (const source of ["rpc", "cache", "shared-background"])
  test(`password business SQL remains independent of its ${source} Resolve admission`, () => {
    const f = businessFixture(source);
    const result = inspectIdentityTraceTopology(f.trace, f.business, [], f);
    assert.equal(result.database_spans, 1);
    assert.equal(result.gateway_resolution.profile, "session");
    assert.equal(
      result.gateway_resolution.source,
      source === "shared-background" ? "shared" : source,
    );
    f.trace.spans.pop();
    assert.throws(
      () => inspectIdentityTraceTopology(f.trace, f.business, [], f),
      /PostgreSQL/,
    );
  });

for (const [name, mutate] of [
  ["missing profile expectation", (f) => delete f.business.resolveProfile],
  ["wrong profile", (f) => (f.business.resolveProfile = "console")],
  [
    "missing decision",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.decision), 1),
  ],
  [
    "wrong source RPC",
    (f) =>
      setTag(
        f.origin.trace.spans.find((span) => span.spanID === "resolve-server"),
        "http.route",
        "/rpc/identity/local-login",
      ),
  ],
])
  test(`business admission rejects ${name} while retaining valid business SQL`, () => {
    const f = businessFixture();
    mutate(f);
    assert.throws(() =>
      inspectIdentityTraceTopology(f.trace, f.business, [], f),
    );
  });

test("Identity mutation keeps its own SQL and reports warnings from the full Resolve closure", async (t) => {
  const f = businessFixture(),
    output = await directory(t);
  f.origin.root.warnings = ["source warning"];
  const result = await verifyIdentityEvidence(
    "http://jaeger",
    [f.business],
    [],
    {
      directory: output,
      attempts: 3,
      wait: async () => {},
      request: async (url) =>
        Response.json({ data: [f.traces.get(url.split("/").at(-1))] }),
    },
  );
  assert.equal(result[0].database_spans, 1);
  assert.equal(result[0].warning_count, 1);
  assert.equal(result[0].strict_trace, "failed");
  assert.deepEqual(result[0].source_trace_ids, [sourceID, triggerID]);
});

for (const invalid of ["business SQL", "source parent", "source secret"])
  test(`Identity mutation closure rejects missing/private ${invalid}`, async (t) => {
    const f = businessFixture(),
      output = await directory(t);
    if (invalid === "business SQL") f.trace.spans.pop();
    if (invalid === "source parent") f.origin.trace.spans.shift();
    if (invalid === "source secret")
      setTag(f.origin.root, "private", "private-source-canary");
    await assert.rejects(
      verifyIdentityEvidence(
        "http://jaeger",
        [f.business],
        ["private-source-canary"],
        {
          directory: output,
          attempts: 3,
          wait: async () => {},
          request: async (url) =>
            Response.json({ data: [f.traces.get(url.split("/").at(-1))] }),
        },
      ),
    );
  });

test("strict Identity entry archives sources and rejects their warnings", async (t) => {
  const f = businessFixture(),
    output = await directory(t);
  f.origin.root.warnings = ["source warning"];
  await assert.rejects(
    verifyIdentityTraces("http://jaeger", [f.business], [], {
      directory: output,
      wait: async () => {},
      request: async (url) =>
        Response.json({ data: [f.traces.get(url.split("/").at(-1))] }),
    }),
    /warnings/,
  );
  assert.equal(
    JSON.parse(await readFile(join(output, sourceID + ".json"), "utf8"))
      .traceID,
    sourceID,
  );
});

for (const absent of ["none", "SERVER", "SQL"])
  test(`cache admission still validates later live revalidation with ${absent} absent`, () => {
    const f = fixture("cache");
    const rpc = addResolveRPC(f.trace, "-later", f.upstream.startTime + 2000);
    const decision = structuredClone(f.decision);
    decision.spanID = "later-decision";
    decision.startTime = f.upstream.startTime + 1000;
    decision.duration = 5000;
    decision.tags = fields({
      "span.kind": "internal",
      [resolvePrefix + "profile"]: "acp",
      [resolvePrefix + "source"]: "rpc",
      [resolvePrefix + "outcome"]: "admitted",
    });
    f.trace.spans.push(decision);
    if (absent === "SERVER")
      f.trace.spans = f.trace.spans.filter(
        (span) => ![rpc.server, rpc.sql].includes(span),
      );
    if (absent === "SQL")
      f.trace.spans = f.trace.spans.filter((span) => span !== rpc.sql);
    if (absent === "none") {
      const result = inspectSessionClosure(f.trace, f.expected, [], f);
      assert.equal(result.identity_sql, 1);
      assert.equal(result.gateway_revalidations[0].source, "rpc");
    } else
      assert.throws(() => inspectSessionClosure(f.trace, f.expected, [], f));
  });

test("sampling joins an asynchronous inspector and observes its final-sample cancellation", async (t) => {
  const f = businessFixture(),
    output = await directory(t),
    controller = new AbortController();
  let inspected = 0,
    active = 0;
  await assert.rejects(
    verifyIdentityEvidence("http://jaeger", [f.business], [], {
      directory: output,
      attempts: 3,
      wait: async () => {},
      signal: controller.signal,
      request: async (url) =>
        Response.json({ data: [f.traces.get(url.split("/").at(-1))] }),
      inspect: async (...args) => {
        active++;
        try {
          await Promise.resolve();
          if (++inspected === 3) controller.abort(new Error("stop sampling"));
          return inspectIdentityTraceTopology(...args);
        } finally {
          active--;
        }
      },
    }),
    /stop sampling/,
  );
  assert.equal(inspected, 3);
  assert.equal(active, 0);
});

test("strict Identity entry rejects source errors without suppressing their raw evidence", async (t) => {
  const f = businessFixture(),
    output = await directory(t);
  setTag(f.origin.root, "error", true);
  await assert.rejects(
    verifyIdentityTraces("http://jaeger", [f.business], [], {
      directory: output,
      wait: async () => {},
      request: async (url) =>
        Response.json({ data: [f.traces.get(url.split("/").at(-1))] }),
    }),
    /error/,
  );
  assert.equal(
    JSON.parse(await readFile(join(output, sourceID + ".json"), "utf8"))
      .traceID,
    sourceID,
  );
});

test("strict Identity cancellation during the initial wait never starts a query", async (t) => {
  const f = businessFixture(),
    output = await directory(t),
    controller = new AbortController();
  let queries = 0;
  await assert.rejects(
    verifyIdentityTraces("http://jaeger", [f.business], [], {
      directory: output,
      signal: controller.signal,
      wait: async () => controller.abort(new Error("stop sampling")),
      request: async (url) => {
        queries++;
        return Response.json({ data: [f.traces.get(url.split("/").at(-1))] });
      },
    }),
    /stop sampling/,
  );
  assert.equal(queries, 0);
});

test("Console ancestry selects its own profile and keeps the real business SQL", () => {
  const f = businessFixture("cache");
  setTag(f.root, "http.route", "/api/admin/provisioning/scim-tokens");
  setTag(f.decision, resolvePrefix + "profile", "console");
  f.trace.processes.console = { serviceName: "admin-console" };
  const server = {
    ...structuredClone(f.upstream),
    processID: "console",
    spanID: "console-server",
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.upstream.spanID,
      },
    ],
    tags: fields({
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/api/admin/provisioning/scim-tokens",
    }),
  };
  const client = {
    ...structuredClone(f.upstream),
    processID: "console",
    spanID: "console-client",
    references: [
      { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: server.spanID },
    ],
  };
  f.trace.spans.push(server, client);
  f.trace.spans.find(
    (span) => span.spanID === "business",
  ).references[0].spanID = client.spanID;
  delete f.business.resolveProfile;
  f.business.console = true;
  const result = inspectIdentityTraceTopology(f.trace, f.business, [], f);
  assert.equal(result.gateway_resolution.profile, "console");
  assert.equal(result.database_spans, 1);
  setTag(f.decision, resolvePrefix + "profile", "session");
  assert.throws(
    () => inspectIdentityTraceTopology(f.trace, f.business, [], f),
    /profile/,
  );
});

test("several shared revalidations count the actual source SQL once", () => {
  const f = fixture("shared");
  for (let i = 1; i <= 2; i++) {
    const decision = structuredClone(f.decision);
    decision.spanID = `revalidation-${i}`;
    decision.startTime = f.upstream.startTime + 10000 * i;
    f.trace.spans.push(decision);
  }
  const result = inspectSessionClosure(f.trace, f.expected, [], f);
  assert.equal(result.gateway_revalidations.length, 2);
  assert.equal(result.identity_sql, 1);
});

test("failed source topology remains archived and cannot accumulate stable samples", async (t) => {
  const f = fixture("shared"),
    output = await directory(t);
  f.origin.trace.spans.shift();
  let sources = 0;
  await assert.rejects(
    collectSessionClosure("http://jaeger", f.expected, [], {
      directory: output,
      attempts: 3,
      wait: async () => {},
      request: async (url) => {
        const id = url.split("/").at(-1);
        if (id === sourceID) sources++;
        return Response.json({ data: [f.traces.get(id)] });
      },
    }),
    /parent/,
  );
  assert.equal(sources, 3);
  assert.deepEqual(
    JSON.parse(await readFile(join(output, sourceID + ".json"), "utf8")),
    f.origin.trace,
  );
});

test("a missing source sample resets convergence of an unchanged current trace", async (t) => {
  const f = fixture("shared"),
    output = await directory(t);
  let sources = 0;
  const result = await collectSessionClosure("http://jaeger", f.expected, [], {
    directory: output,
    attempts: 6,
    wait: async () => {},
    request: async (url) => {
      const id = url.split("/").at(-1);
      if (id === sourceID && ++sources === 3)
        return new Response("{}", { status: 404 });
      return Response.json({ data: [f.traces.get(id)] });
    },
  });
  assert.equal(sources, 6);
  assert.equal(result.strict_trace, "passed");
});

for (const entry of ["closure", "strict"])
  for (const target of ["current", "source"])
    for (const phase of ["request", "body"])
      test(`cancel ${entry} ${target} ${phase} joins the active read before returning`, async (t) => {
        const f =
            entry === "closure" ? fixture("shared") : businessFixture("shared"),
          output = await directory(t),
          controller = new AbortController();
        let active = 0,
          finished = false,
          waits = 0;
        const blockedRead = (signal) =>
          new Promise((resolve, reject) => {
            active++;
            signal.addEventListener(
              "abort",
              () => {
                active--;
                finished = true;
                reject(signal.reason);
              },
              { once: true },
            );
            queueMicrotask(() => controller.abort(new Error("stop sampling")));
          });
        const collect = (options) =>
          entry === "closure"
            ? collectSessionClosure("http://jaeger", f.expected, [], options)
            : verifyIdentityTraces("http://jaeger", [f.business], [], options);
        await assert.rejects(
          collect({
            directory: output,
            attempts: 3,
            signal: controller.signal,
            wait: async () => {
              waits++;
            },
            request: async (url, { signal }) => {
              const id = url.split("/").at(-1);
              if ((target === "source") === (id === sourceID)) {
                if (phase === "request") return blockedRead(signal);
                return { status: 200, text: () => blockedRead(signal) };
              }
              return Response.json({ data: [f.traces.get(id)] });
            },
          }),
          /stop sampling/,
        );
        assert.equal(active, 0);
        assert.equal(finished, true);
        assert.equal(waits, entry === "strict" ? 1 : 0);
      });
