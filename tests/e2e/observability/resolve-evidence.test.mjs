import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { fields } from "./trace-fixtures.mjs";
import {
  addResolveRPC,
  setTag,
  sourceID,
  triggerID,
} from "./gateway-resolution-fixtures.mjs";
import { observabilityResolutionFixture } from "./resolve-evidence-fixtures.mjs";
import {
  inspectObservabilityResolution,
  collectObservabilityResolution,
} from "./resolve-evidence.mjs";

const failed = {
  name: "Error",
  message: "observability Resolve evidence validation failed",
};
const inspect = (f) => inspectObservabilityResolution(f.trace, f.expected, f);

function collectorFixture(
  t,
  source = "shared-background",
  profile = "session",
) {
  const f = observabilityResolutionFixture(source, profile);
  f.directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-observability-resolve-"),
  );
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  f.requests = [];
  f.waits = [];
  f.request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    f.requests.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  f.wait = async (ms) => {
    f.waits.push(ms);
  };
  f.inspect = async () => ({ business_verified: true });
  return f;
}
const collect = (f, options = {}) =>
  collectObservabilityResolution("http://jaeger", f.expected, {
    ...f,
    ...options,
  });

for (const route of ["/api/session", "/api/admin/{path...}"])
  test(`ordinary ${route} cannot capture content by adding RPC tags`, () => {
    const f = observabilityResolutionFixture(
      "cache",
      route === "/api/session" ? "session" : "console",
    );
    setTag(f.root, "rpc.method", "resolve_access_token");
    setTag(f.root, "rpc.service", "identity");
    setTag(f.root, "rpc.system.name", "antnest.http-json");
    f.root.logs = ["antnest.request", "antnest.response"].map((event) => ({
      fields: fields({
        event,
        "antnest.payload.json": '{"token":"private-secret"}',
      }),
    }));
    assert.throws(() => inspect(f), failed);
  });

test("foreground shared creator cancellation is a real source ERROR, not an allowed clean source", () => {
  const f = observabilityResolutionFixture("shared");
  const creator = f.origin.decision;
  setTag(creator, "antnest.identity.resolve.outcome", "unavailable");
  setTag(creator, "otel.status_code", "ERROR");
  creator.duration = 100;
  f.origin.root.duration = 10500;
  assert.throws(() => inspect(f), failed);
});

for (const [service, rpcService, method, route, rpcMethod, allowed] of [
  [
    "identity-service",
    "identity",
    "POST",
    "/rpc/identity/resolve-owner-authorization",
    "resolve_owner_authorization",
    true,
  ],
  [
    "identity-service",
    "identity",
    "GET",
    "/status",
    "resolve_owner_authorization",
    false,
  ],
  [
    "identity-service",
    "identity",
    "POST",
    "/rpc/identity/not-registered",
    "not_registered",
    false,
  ],
  [
    "agent-controller",
    "agent-controller",
    "PUT",
    "/internal/agents/{agent_id}/network-policy",
    "PUT /internal/agents/{agent_id}/network-policy",
    true,
  ],
  [
    "agent-controller",
    "agent-controller",
    "GET",
    "/internal/agents/{agent_id}/events/watch",
    "GET /internal/agents/{agent_id}/events/watch",
    false,
  ],
  [
    "agent-controller",
    "agent-controller",
    "POST",
    "/internal/agent-templates",
    "POST /internal/agent-templates",
    false,
  ],
  [
    "runtime-controller",
    "runtime-controller",
    "POST",
    "/internal/runtimes/{agent_id}/initialize",
    "POST /internal/runtimes/{agent_id}/initialize",
    true,
  ],
  [
    "runtime-controller",
    "runtime-controller",
    "GET",
    "/internal/runtime-observations/watch",
    "GET /internal/runtime-observations/watch",
    false,
  ],
  [
    "runtime-controller",
    "runtime-controller",
    "POST",
    "/internal/runtimes/{agent_id}/connection",
    "POST /internal/runtimes/{agent_id}/connection",
    false,
  ],
  [
    "antnest-runtime-egress",
    "runtime-egress.control",
    "PUT",
    "/internal/agent-policy-assignments/{agent_id}",
    "assign_policy",
    true,
  ],
  [
    "antnest-runtime-egress",
    "runtime-egress.control",
    "PUT",
    "/internal/agent-tunnel-keys/{agent_id}",
    "register_tunnel",
    false,
  ],
  [
    "admin-console",
    "identity",
    "POST",
    "/api/admin/organizations",
    "resolve_owner_authorization",
    false,
  ],
])
  test(`${service} content requires a registered receiving boundary: ${method} ${route}`, () => {
    const f = observabilityResolutionFixture("cache", "console");
    // Separate owning business RPC, beneath this request's Console SERVER.
    const client = structuredClone(
      f.trace.spans.find((s) => s.spanID === "console"),
    );
    client.spanID = "business-client";
    client.references[0].spanID = "console";
    setTag(client, "span.kind", "client");
    setTag(client, "http.request.method", method);
    const server = structuredClone(client);
    server.spanID = "business-server";
    server.processID = "business";
    server.references[0].spanID = client.spanID;
    setTag(server, "span.kind", "server");
    setTag(server, "http.route", route);
    setTag(server, "rpc.method", rpcMethod);
    setTag(server, "rpc.service", rpcService);
    setTag(server, "rpc.system.name", "antnest.http-json");
    server.logs = [
      {
        fields: fields({
          event: "antnest.response",
          "antnest.payload.json": '{"nested":{"token":"private-secret"}}',
        }),
      },
    ];
    if (service === "admin-console") {
      // Preserve the one real Console SERVER and its admitted HTTP boundary;
      // only the forged RPC metadata and content should make this fail.
      const ordinary = f.trace.spans.find((s) => s.spanID === "console");
      setTag(ordinary, "rpc.method", rpcMethod);
      setTag(ordinary, "rpc.service", rpcService);
      setTag(ordinary, "rpc.system.name", "antnest.http-json");
      ordinary.logs = server.logs;
    } else {
      f.trace.processes.business = { serviceName: service };
      f.trace.spans.push(client, server);
    }
    if (allowed) assert.equal(inspect(f).source, "cache");
    else assert.throws(() => inspect(f), failed);
  });

test("snapshot convergence compares span identities while preserving raw array order", async (t) => {
  const f = collectorFixture(t);
  let sample = 0;
  const request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    if (id === f.trace.traceID) sample++;
    if (sample === 2) f.traces.get(id).spans.reverse();
    return f.request(url);
  };
  const result = await collect(f, { request });
  const raw = (n) =>
    JSON.parse(
      readFileSync(
        join(result.evidence_directory, `sample-${n}`, `${sourceID}.json`),
        "utf8",
      ),
    );
  assert.deepEqual(
    raw(1).spans.map((s) => s.spanID),
    raw(2)
      .spans.map((s) => s.spanID)
      .reverse(),
  );
  assert.equal(sample, 3);
});

for (const stage of [
  "request",
  "body",
  "source-request",
  "source-body",
  "inspector",
])
  test(`caller cancellation reaches the actual ${stage} and joins cleanup`, async (t) => {
    const f = collectorFixture(t);
    const controller = new AbortController(),
      decoy = new AbortController();
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let active = 0,
      settled = false,
      observed;
    f.expected.signal = decoy.signal;
    const hold = async (signal) => {
      active++;
      try {
        entered.resolve();
        assert(
          signal instanceof AbortSignal,
          "active operation did not receive cancellation",
        );
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        });
        observed = signal.reason;
        await release.promise;
        signal.throwIfAborted();
      } finally {
        active--;
      }
    };
    const options = { signal: controller.signal };
    if (stage === "inspector")
      options.inspect = async (_trace, _expected, collection) => {
        await hold(collection.signal);
        return {};
      };
    else
      options.request = async (url, { signal }) => {
        const id = new URL(url).pathname.split("/").at(-1);
        const target = stage.startsWith("source-") ? sourceID : f.trace.traceID;
        if (id !== target) return f.request(url);
        if (stage.endsWith("request")) await hold(signal);
        return {
          status: 200,
          text: async () => {
            if (stage.endsWith("body")) await hold(signal);
            return JSON.stringify({ data: [f.traces.get(id)] });
          },
        };
      };
    const reason = new Error("actual caller cancellation");
    const promise = collect(f, options);
    const rejection = assert
      .rejects(promise, (error) => error === reason)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    controller.abort(reason);
    try {
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(observed, reason);
      assert.equal(decoy.signal.aborted, false);
      assert.equal(active, 1);
      assert.equal(settled, false);
    } finally {
      decoy.abort(new Error("unrelated decoy cancellation"));
      release.resolve();
      await rejection;
    }
    assert.equal(active, 0);
  });

for (const profile of ["session", "console"])
  for (const source of ["rpc", "cache", "shared", "shared-background"])
    test(`${profile} Resolve accepts actual ${source} receipt and captured receiving payload`, () => {
      const f = observabilityResolutionFixture(source, profile);
      const result = inspect(f);
      assert.equal(result.profile, profile);
      assert.equal(
        result.source,
        source.startsWith("shared") ? "shared" : source,
      );
      assert.equal(result.database_spans, source === "cache" ? 0 : 1);
    });

test("legal complete receiving payload can contain credentials and exceed 16 KiB", () => {
  const f = observabilityResolutionFixture("shared-background");
  const body = JSON.stringify({
    password: "private-password-canary",
    token: "private-token-canary",
    provider: { credential: "private-provider-canary" },
    unknown: { nested: "x".repeat(18000) },
  });
  f.traces
    .get(sourceID)
    .spans.find(
      (span) => span.spanID === "resolve-server",
    ).logs[0].fields[1].value = body;
  assert.equal(inspect(f).source, "shared");
  assert(!JSON.stringify(inspect(f)).includes("private-"));
});

for (const [name, mutate] of [
  [
    "wrong actual trace",
    (f) => {
      f.expected.traceID = "f".repeat(32);
    },
  ],
  [
    "profile copied from marker",
    (f) => {
      f.expected.profile = "workspace";
    },
  ],
  [
    "missing explicit TTL",
    (f) => {
      delete f.expected.resolveTTLMS;
    },
  ],
  [
    "missing capture setting",
    (f) => {
      delete f.captureRpcContent;
    },
  ],
  [
    "missing source archive",
    (f) => {
      f.archivedTraceIDs.delete(sourceID);
    },
  ],
  [
    "cached request invents RPC",
    (f) => {
      setTag(f.decision, "antnest.identity.resolve.source", "cache");
      f.decision.references = f.decision.references.filter(
        (ref) => ref.refType === "CHILD_OF",
      );
      setTag(f.decision, "antnest.identity.resolve.snapshot_age_ms", 2);
      setTag(f.decision, "antnest.identity.resolve.proof_age_ms", 2);
      setTag(f.decision, "antnest.identity.resolve.valid_for_ms", 9998);
      addResolveRPC(f.trace);
    },
  ],
  [
    "session admits UPDATE",
    (f) => {
      const sql = f.traces
        .get(sourceID)
        .spans.find((span) => span.spanID === "sql");
      sql.operationName = "UPDATE";
      setTag(sql, "db.operation.name", "UPDATE");
      setTag(sql, "db.query.text", "UPDATE sessions SET last_used_at=$1");
    },
  ],
  [
    "duplicate source SELECT",
    (f) => {
      const source = f.traces.get(sourceID);
      const sql = structuredClone(
        source.spans.find((span) => span.spanID === "sql"),
      );
      sql.spanID = "extra-select";
      source.spans.push(sql);
    },
  ],
  [
    "source SERVER ERROR despite 200",
    (f) => {
      setTag(
        f.traces
          .get(sourceID)
          .spans.find((span) => span.spanID === "resolve-server"),
        "otel.status_code",
        "ERROR",
      );
    },
  ],
  [
    "source SQL exception",
    (f) => {
      f.traces.get(sourceID).spans.find((span) => span.spanID === "sql").logs =
        [
          {
            fields: fields({
              event: "exception",
              "exception.message": "private-secret",
            }),
          },
        ];
    },
  ],
  [
    "missing request content",
    (f) => {
      f.traces
        .get(sourceID)
        .spans.find((span) => span.spanID === "resolve-server")
        .logs.shift();
    },
  ],
  [
    "duplicate response content",
    (f) => {
      const s = f.traces
        .get(sourceID)
        .spans.find((span) => span.spanID === "resolve-server");
      s.logs.push(structuredClone(s.logs[1]));
    },
  ],
  [
    "malformed content",
    (f) => {
      f.traces
        .get(sourceID)
        .spans.find(
          (span) => span.spanID === "resolve-server",
        ).logs[0].fields[1].value = "private-secret-invalid-json";
    },
  ],
  [
    "content disabled in deployment",
    (f) => {
      f.captureRpcContent = false;
    },
  ],
  [
    "CLIENT content",
    (f) => {
      f.traces
        .get(sourceID)
        .spans.find((span) => span.spanID === "resolve-client").logs = [
        {
          fields: fields({
            event: "antnest.response",
            "antnest.payload.json": "{}",
          }),
        },
      ];
    },
  ],
  [
    "ordinary HTTP content",
    (f) => {
      f.root.logs = [
        {
          fields: fields({
            event: "antnest.request",
            "antnest.payload.json": "{}",
          }),
        },
      ];
    },
  ],
  [
    "headers in event",
    (f) => {
      f.root.logs = [
        {
          fields: fields({
            "http.request.header.authorization": "private-secret",
          }),
        },
      ];
    },
  ],
  [
    "HTTP body",
    (f) => {
      setTag(f.root, "http.response.body", "private-secret");
    },
  ],
  [
    "SQL parameters",
    (f) => {
      setTag(
        f.traces.get(sourceID).spans.find((span) => span.spanID === "sql"),
        "db.query.parameters.token",
        "private-secret",
      );
    },
  ],
  [
    "unregistered Resolve tag",
    (f) => {
      setTag(f.decision, "antnest.identity.resolve.token", "private-secret");
    },
  ],
  [
    "Resolve secret in logs",
    (f) => {
      f.decision.logs = [
        {
          fields: fields({
            "antnest.identity.resolve.token": "private-secret",
          }),
        },
      ];
    },
  ],
  [
    "payload outside content event",
    (f) => {
      f.root.logs = [
        { fields: fields({ event: "note", "antnest.payload.json": "{}" }) },
      ];
    },
  ],
  [
    "payload attribute",
    (f) => {
      setTag(f.root, "antnest.payload.json", "{}");
    },
  ],
  [
    "source warning",
    (f) => {
      f.traces.get(sourceID).warnings = ["private-secret-warning"];
    },
  ],
  [
    "trigger error",
    (f) => {
      setTag(f.traces.get(triggerID).spans[0], "antnest.outcome", "failure");
    },
  ],
])
  test(`Resolve content mode rejects ${name} without exposing raw evidence`, () => {
    const f = observabilityResolutionFixture("shared-background");
    mutate(f);
    assert.throws(() => inspect(f), failed);
  });

for (const [name, mutate] of [
  [
    "forwarding begins before admission",
    (f) => {
      f.upstream.startTime = f.decision.startTime;
    },
  ],
  [
    "Console directly under root",
    (f) => {
      f.trace.spans.find(
        (span) => span.spanID === "console",
      ).references[0].spanID = "root";
    },
  ],
  [
    "wrong Console route",
    (f) => {
      setTag(
        f.trace.spans.find((span) => span.spanID === "console"),
        "http.route",
        "/unrelated",
      );
    },
  ],
])
  test(`Console Resolve rejects ${name}`, () => {
    const f = observabilityResolutionFixture("cache", "console");
    mutate(f);
    assert.throws(() => inspect(f), failed);
  });

test("disabled capture accepts real RPC/SQL without content", () => {
  const f = observabilityResolutionFixture("rpc");
  f.captureRpcContent = false;
  f.trace.spans.find((span) => span.spanID === "resolve-server").logs = [];
  assert.equal(inspect(f).database_spans, 1);
});

test("collector waits six seconds then archives three identical full closures privately", async (t) => {
  const f = collectorFixture(t);
  const result = await collect(f);
  assert.deepEqual(f.waits, [6000, 1000, 1000]);
  assert.deepEqual(
    f.requests,
    Array(3).fill([f.trace.traceID, sourceID, triggerID]).flat(),
  );
  assert.equal(result.business_verified, true);
  assert.equal(result.gateway_resolution.source, "shared");
  assert.equal(result.error_spans, 0);
  assert.equal(result.strict_trace, "passed");
  assert.deepEqual(result.source_trace_ids, [sourceID, triggerID]);
  for (let sample = 1; sample <= 3; sample++) {
    const directory = join(result.evidence_directory, `sample-${sample}`);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const [id, trace] of f.traces) {
      const path = join(directory, `${id}.json`);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), trace);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  }
});

test("separate collections of the same request retain independent sample archives", async (t) => {
  const f = collectorFixture(t, "cache");
  const first = await collect(f);
  const second = await collect(f);
  assert.notEqual(first.evidence_directory, second.evidence_directory);
});

for (const mutation of [
  "payload",
  "late-sql",
  "warning",
  "api-error",
  "http-error",
  "invalid-json",
])
  test(`collector rejects ${mutation} immediately without retrying until a pass`, async (t) => {
    const f = collectorFixture(t);
    let sample = 0;
    const request = async (url) => {
      const id = new URL(url).pathname.split("/").at(-1);
      if (id === f.trace.traceID) sample++;
      if (sample === 2 && id === sourceID) {
        if (mutation === "api-error")
          return Response.json({
            errors: [{ message: "private-secret" }],
            data: [],
          });
        if (mutation === "http-error")
          return new Response("private-secret", { status: 503 });
        if (mutation === "invalid-json")
          return new Response("private-secret-invalid-json");
        const source = f.traces.get(sourceID);
        if (mutation === "payload")
          source.spans.find(
            (s) => s.spanID === "resolve-server",
          ).logs[0].fields[1].value = '{"late":"private-secret"}';
        if (mutation === "late-sql") {
          const sql = structuredClone(
            source.spans.find((s) => s.spanID === "sql"),
          );
          sql.spanID = "late-sql";
          source.spans.push(sql);
        }
        if (mutation === "warning") source.warnings = ["private-secret"];
      }
      return f.request(url);
    };
    await assert.rejects(collect(f, { request }), failed);
    assert.equal(sample, 2);
    const run = readdirSync(f.directory)[0];
    const raw = readFileSync(
      join(f.directory, run, "sample-2", `query-${sourceID}.txt`),
      "utf8",
    );
    assert(
      raw.includes(mutation === "late-sql" ? "late-sql" : "private-secret"),
    );
  });

for (const options of [
  { directory: undefined },
  { directory: ".cache/forbidden" },
  { inspect: undefined },
  { captureRpcContent: undefined },
])
  test(`collector validates explicit configuration before waiting or querying: ${Object.keys(options)}`, async (t) => {
    const f = collectorFixture(t);
    await assert.rejects(collect(f, options), failed);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.requests, []);
  });

test("current business retry diagnostics remain counted and cannot override strict failure", async (t) => {
  const f = collectorFixture(t, "cache", "console");
  const retry = structuredClone(
    f.trace.spans.find((s) => s.spanID === "console"),
  );
  retry.spanID = "business-retry";
  retry.processID = "controller";
  retry.references[0].spanID = "console";
  f.trace.processes.controller = { serviceName: "agent-controller" };
  setTag(retry, "span.kind", "internal");
  setTag(retry, "otel.status_code", "ERROR");
  f.trace.spans.push(retry);
  const result = await collect(f, {
    inspect: async () => ({
      retry_verified: true,
      strict_trace: "failed",
      error_spans: [{ span_id: retry.spanID }],
    }),
  });
  assert.equal(result.error_spans, 1);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.retry_verified, true);
  assert.deepEqual(result.inspector_diagnostics.error_spans, [
    { span_id: retry.spanID },
  ]);
});

for (const stage of ["request", "body", "inspector"])
  test(`abort joins the active ${stage} before rejecting with the original reason`, async (t) => {
    const f = collectorFixture(t, "cache");
    const controller = new AbortController();
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let joined = false,
      settled = false;
    const hold = async () => {
      entered.resolve();
      await release.promise;
      joined = true;
    };
    const options = { signal: controller.signal };
    if (stage === "request")
      options.request = async () => {
        await hold();
        return Response.json({ data: [f.trace] });
      };
    if (stage === "body")
      options.request = async () => ({
        status: 200,
        text: async () => {
          await hold();
          return JSON.stringify({ data: [f.trace] });
        },
      });
    if (stage === "inspector")
      options.inspect = async () => {
        await hold();
        return {};
      };
    const promise = collect(f, options);
    const reason = new Error("owned cancellation");
    const rejection = assert
      .rejects(promise, (error) => error === reason)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    controller.abort(reason);
    try {
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(joined, false);
    } finally {
      release.resolve();
      await rejection;
    }
    assert.equal(joined, true);
  });
