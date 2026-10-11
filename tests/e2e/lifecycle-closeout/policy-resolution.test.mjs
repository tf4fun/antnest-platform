import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as network from "./network-flow.mjs";
import { fixture as policyFixture } from "./network-trace-fixtures.mjs";
import {
  resolutionFixture,
  sharedResolutionFixture,
  sourceID,
  triggerID,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";
import {
  collectLifecycleEvidence,
  foundationTraceExitCode,
} from "./foundation-evidence.mjs";

function fixture(source = "shared") {
  const f =
    source === "shared"
      ? sharedResolutionFixture(true)
      : resolutionFixture(source);
  for (const trace of f.traces.values())
    for (const span of trace.spans)
      if (span.tags.some((field) => field.key === prefix + "profile"))
        setTag(span, prefix + "profile", "console");
  f.root.operationName = "HTTP PUT /api/admin/{path...}";
  setTag(f.root, "http.route", "/api/admin/{path...}");
  setTag(f.root, "http.request.method", "PUT");
  f.upstream.operationName = "HTTP PUT admin-console";
  setTag(f.upstream, "http.request.method", "PUT");
  setTag(f.upstream, "http.response.status_code", 200);
  const business = policyFixture();
  Object.assign(f.trace.processes, business.processes);
  for (const original of business.spans.slice(1)) {
    const span = structuredClone(original);
    span.spanID = `policy-${span.spanID}`;
    span.traceID = f.trace.traceID;
    span.startTime = f.upstream.startTime + Number(original.spanID);
    span.duration = 100;
    span.references = original.references.map((ref) => ({
      ...ref,
      traceID: f.trace.traceID,
      spanID: ref.spanID === "0" ? "upstream" : `policy-${ref.spanID}`,
    }));
    setTag(span, "span.kind", "server");
    if (original.spanID === "1") {
      span.operationName =
        "HTTP PUT /api/admin/agents/{agent_id}/network-policy";
      for (const [key, value] of Object.entries({
        "http.request.method": "PUT",
        "http.route": "/api/admin/agents/{agent_id}/network-policy",
        "http.response.status_code": 200,
      }))
        setTag(span, key, value);
      f.console = span;
    }
    if (original.spanID === "3") f.egress = span;
    f.trace.spans.push(span);
  }
  f.expected = {
    traceID: f.trace.traceID,
    agentID: "agent-a",
    action: "deny_all",
  };
  return f;
}

const inspect = (f) => {
  assert.equal(typeof network.inspectPolicyResolution, "function");
  return network.inspectPolicyResolution(f.trace, f.expected, ["PRIVATE"], f);
};

function collection(t, source = "shared") {
  const f = fixture(source);
  const evidence = mkdtempSync(
    join(temporaryStorageRoot(), "lifecycle-policy-"),
  );
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  f.config = { evidence, jaeger: "http://jaeger" };
  f.directory = join(evidence, "traces");
  f.reads = new Map();
  f.options = {
    attempts: 4,
    wait: async () => {},
    request: async (url) => {
      const id = new URL(url).pathname.split("/").at(-1);
      f.reads.set(id, (f.reads.get(id) ?? 0) + 1);
      return Response.json({ data: [f.traces.get(id)] });
    },
  };
  return f;
}
const collect = (f) => {
  assert.equal(typeof network.collectPolicyTrace, "function");
  return network.collectPolicyTrace(
    f.config,
    f.expected,
    ["PRIVATE"],
    f.signal,
    f.options,
  );
};

for (const source of ["rpc", "cache", "shared"])
  test(`policy PUT retains exact Egress write with ${source} Console admission`, () => {
    const f = fixture(source);
    const before = JSON.stringify([...f.traces.values()]);
    const result = inspect(f);
    assert.equal(result.profile, "console");
    assert.equal(result.source, source);
    assert.equal(result.admission, true);
    assert.equal(
      network.inspectPolicyTrace(f.trace, f.expected).gateway_ancestry,
      true,
    );
    assert.equal(JSON.stringify([...f.traces.values()]), before);
  });

for (const [name, mutate] of [
  [
    "wrong request Trace",
    (f) => {
      f.expected.traceID = "f".repeat(32);
    },
  ],
  [
    "different Gateway route",
    (f) => setTag(f.root, "http.route", "/api/app/{path...}"),
  ],
  ["POST Gateway method", (f) => setTag(f.root, "http.request.method", "POST")],
  [
    "202 Gateway status",
    (f) => setTag(f.root, "http.response.status_code", 202),
  ],
  [
    "wrong Console route",
    (f) =>
      setTag(f.console, "http.route", "/api/admin/agents/{agent_id}/rebuild"),
  ],
  [
    "POST Console method",
    (f) => setTag(f.console, "http.request.method", "POST"),
  ],
  [
    "failed Console status",
    (f) => setTag(f.console, "http.response.status_code", 500),
  ],
  ["non-SERVER Console", (f) => setTag(f.console, "span.kind", "internal")],
  [
    "wrong forwarding service",
    (f) => {
      f.upstream.processID = "1";
    },
  ],
  ["non-CLIENT forwarding", (f) => setTag(f.upstream, "span.kind", "internal")],
  [
    "wrong forwarding method",
    (f) => setTag(f.upstream, "http.request.method", "POST"),
  ],
  [
    "failed forwarding status",
    (f) => setTag(f.upstream, "http.response.status_code", 500),
  ],
  [
    "nested forwarding",
    (f) => {
      f.upstream.references[0].spanID = "decision";
    },
  ],
  [
    "missing decision",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.decision);
    },
  ],
  [
    "duplicate decision",
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.decision),
        spanID: "second-decision",
      });
    },
  ],
  ["wrong profile", (f) => setTag(f.decision, prefix + "profile", "workspace")],
  [
    "late admission",
    (f) => {
      f.decision.duration = 50000;
    },
  ],
  [
    "missing archive",
    (f) => {
      f.archivedTraceIDs.delete(sourceID);
    },
  ],
  [
    "missing Resolve SQL",
    (f) => {
      f.traces.get(sourceID).spans = f.traces
        .get(sourceID)
        .spans.filter((s) => s.spanID !== "sql");
    },
  ],
  [
    "private source",
    (f) => {
      f.traces.get(sourceID).private = "PRIVATE";
    },
  ],
  [
    "unknown source attribute",
    (f) => setTag(f.traces.get(sourceID).spans[0], prefix + "secret", "bad"),
  ],
  [
    "captured trigger content",
    (f) => {
      f.traces.get(triggerID).spans[0].logs = [
        { fields: fields({ "antnest.payload.json": "{}" }) },
      ];
    },
  ],
])
  test(`policy admission rejects ${name}`, () => {
    const f = fixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const id of ["resolve-client", "resolve-server", "sql"])
  test(`policy admission rejects error in actual Resolve ${id} despite HTTP 200`, () => {
    const f = fixture();
    inspect(f);
    setTag(
      f.traces.get(sourceID).spans.find((span) => span.spanID === id),
      "error",
      true,
    );
    assert.throws(() => inspect(f), /failed actual Resolve/u);
  });

test("policy Egress write must belong to the admitted Console SERVER", () => {
  const f = fixture();
  inspect(f);
  const sibling = structuredClone(f.console);
  sibling.spanID = "unrelated-console";
  sibling.operationName = "unrelated internal work";
  sibling.tags = [];
  f.trace.spans.push(sibling);
  f.trace.spans.find((s) => s.spanID === "policy-2").references[0].spanID =
    sibling.spanID;
  // The historical business gate proves service ancestry, not this identity.
  assert.equal(
    network.inspectPolicyTrace(f.trace, f.expected).gateway_ancestry,
    true,
  );
  assert.throws(() => inspect(f), /admitted Console/u);
});

test("policy admission accepts Jaeger's legacy HTTP status alias without changing raw evidence", () => {
  const f = fixture("cache");
  for (const span of [f.root, f.console]) {
    setTag(span, "http.response.status_code", undefined);
    setTag(span, "http.status_code", 200);
  }
  assert.equal(inspect(f).admission, true);
  setTag(f.console, "http.response.status_code", 500);
  assert.throws(() => inspect(f), /conflicting HTTP status/u);
});

for (const source of ["rpc", "cache", "shared"])
  test(`policy collector validates ${source} sources and archives three full snapshots`, async (t) => {
    const f = collection(t, source);
    const result = await collect(f);
    assert.equal(result.gateway_resolution.source, source);
    assert.equal(result.gateway_ancestry, true);
    assert.equal(result.action, "deny_all");
    assert.equal(result.strict_trace, "passed");
    for (const [id, trace] of f.traces) {
      assert.equal(f.reads.get(id), 3);
      assert.deepEqual(
        JSON.parse(readFileSync(join(f.directory, `${id}.json`))),
        trace,
      );
    }
  });

for (const [name, mutate, message] of [
  [
    "foreign Agent",
    (f) => setTag(f.egress, "antnest.agent.id", "other-agent"),
    /other-agent/u,
  ],
  [
    "failed Egress",
    (f) => setTag(f.egress, "http.response.status_code", 500),
    /unexpected policy error|Egress policy RPC/u,
  ],
  [
    "wrong Egress route",
    (f) => setTag(f.egress, "http.route", "/other"),
    /\/other/u,
  ],
  [
    "source SQL error",
    (f) =>
      setTag(
        f.traces.get(sourceID).spans.find((s) => s.spanID === "sql"),
        "error",
        true,
      ),
    /failed actual Resolve/u,
  ],
])
  test(`policy collector cannot replace ${name} failure with valid cache evidence`, async (t) => {
    const f = collection(t);
    mutate(f);
    await assert.rejects(collect(f), message);
    for (const [id, trace] of f.traces)
      assert.deepEqual(
        JSON.parse(readFileSync(join(f.directory, `${id}.json`))),
        trace,
      );
  });

test("policy collector retains source errors and warnings in the strict result", async (t) => {
  const f = collection(t);
  setTag(f.traces.get(triggerID).spans[0], "error", true);
  f.traces.get(sourceID).warnings = ["unknown source warning"];
  const result = await collect(f);
  assert.equal(result.error_spans, 1);
  assert.equal(result.inspector_diagnostics.error_spans, 0);
  assert.equal(result.strict_trace, "failed");
  assert.equal(foundationTraceExitCode([{ ...result, topology: "passed" }]), 2);
  assert.deepEqual(unreviewedWarnings(JSON.stringify(result)), [
    "unknown source warning",
  ]);
});

test("policy source changes reset full closure convergence", async (t) => {
  const f = collection(t);
  const request = f.options.request;
  f.options.request = async (url, options) => {
    if (
      new URL(url).pathname.endsWith(`/${triggerID}`) &&
      f.reads.get(triggerID) === 1
    )
      f.traces.get(triggerID).warnings = ["late source warning"];
    return request(url, options);
  };
  const result = await collect(f);
  assert.equal(f.reads.get(triggerID), 4);
  assert.deepEqual(result.warnings, ["late source warning"]);
  assert.equal(result.strict_trace, "failed");
});

test("policy collector fixes owning inspection and evidence directory", async (t) => {
  const f = collection(t);
  let overridden = false;
  Object.assign(f.options, {
    directory: join(f.config.evidence, "other"),
    signal: AbortSignal.abort(new Error("unrelated abort")),
    inspect: () => {
      overridden = true;
      return {};
    },
  });
  const result = await collect(f);
  assert.equal(result.gateway_ancestry, true);
  assert.equal(overridden, false);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.directory, `${sourceID}.json`))),
    f.traces.get(sourceID),
  );
  setTag(f.egress, "antnest.agent.id", "other-agent");
  await assert.rejects(collect(f), /other-agent/u);
});

test("policy lifecycle collection keeps a failure record for the observed response Trace", async (t) => {
  const f = collection(t);
  setTag(f.decision, prefix + "profile", "workspace");
  const failures = [];
  const result = await collectLifecycleEvidence(
    [f.expected],
    () => collect(f),
    (item, error) => {
      failures.push({ id: item.traceID, error: error.message });
    },
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, f.trace.traceID);
  assert.match(failures[0].error, /wrong Resolve profile/u);
  assert.equal(result[0].trace_id, f.trace.traceID);
  assert.equal(result[0].topology, "failed");
});

for (const phase of ["request", "body"])
  test(`policy collection joins cancelled ${phase} work and propagates the actual signal`, async (t) => {
    const f = collection(t);
    const abort = new AbortController();
    f.signal = abort.signal;
    const reason = new Error(`stop policy ${phase}`);
    f.options.signal = AbortSignal.timeout(60000);
    const request = f.options.request;
    let joined = false;
    f.options.request = async (url, options) => {
      if (new URL(url).pathname.endsWith(`/${sourceID}`)) {
        const finish = async () => {
          abort.abort(reason);
          assert.equal(options.signal.reason, reason);
          await Promise.resolve();
          joined = true;
          return "{}";
        };
        if (phase === "request") {
          await finish();
          throw reason;
        }
        return { ok: true, status: 200, text: finish };
      }
      return request(url, options);
    };
    await assert.rejects(collect(f), (error) => error === reason);
    assert.equal(joined, true);
  });
