import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceStateTraceFixture } from "./private-http-trace.fixture.mjs";
import { workspaceAuthorityTraceFixture } from "./private-authority-trace.fixture.mjs";
import {
  barrierTraceFixture,
  cancelTraceFixture,
} from "../acp-progress/control-trace.fixture.mjs";

const implementation = await import("./private-collectors.mjs").catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes("/workspace-closeout/private-collectors.mjs")
    )
      throw error;
    return {};
  },
);
function collectorFixture(t, f) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-workspace-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let count = 0,
    flushed = false;
  const options = {
    directory,
    attempts: 3,
    wait: async () => {},
    secrets: ["workspace-cct-private-fixture"],
    flush: async () => {
      flushed = true;
    },
    request: async (address) => {
      assert(flushed, "original CLIENT must be flushed before collecting");
      assert.equal(new URL(address).pathname, "/api/traces/" + f.trace.traceID);
      count++;
      return Response.json({ data: [structuredClone(f.trace)] });
    },
  };
  return { options, directory, count: () => count };
}

function sourceArchive(directory) {
  return join(
    directory,
    readdirSync(directory).find((name) => name.startsWith("workspace-http-")),
  );
}
function originalErrors(error) {
  return error instanceof AggregateError
    ? error.errors.flatMap(originalErrors)
    : [error];
}

test("Workspace request collection retains its original owning assertion after convergence fails", async (t) => {
  const f = barrierTraceFixture();
  const directory = mkdtempSync(
    join(tmpdir(), "antnest-workspace-request-failure-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const connection = f.expected.connectionTrace;
  const expected = { ...f.expected, runId: "wrong-original-run" };
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  await assert.rejects(
    implementation.collectWorkspacePrivateRequest(
      "http://jaeger.test",
      expected,
      {
        directory,
        attempts: 3,
        wait: async () => {},
        flush: async () => {},
        request: async (address) => {
          const path = new URL(address).pathname;
          if (path === "/api/v3/trace-summaries")
            return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
          const trace =
            path === `/api/traces/${connection.traceID}` ? connection : f.trace;
          return Response.json({ data: [trace] });
        },
      },
    ),
    (error) => {
      const errors = originalErrors(error);
      assert(
        errors.some((item) =>
          item.message.includes("Workspace Trace uses another Run"),
        ),
      );
      assert(
        errors.some((item) =>
          item.message.includes("private ACP trace collection failed"),
        ),
      );
      return true;
    },
  );
});

test("HTTP source receipts retain original bytes before UTF-8 decoding", async (t) => {
  const f = workspaceStateTraceFixture(),
    c = collectorFixture(t, f);
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify({ data: [f.trace] })),
  ]);
  c.options.request = async () => new Response(bytes);
  const report = await implementation.collectWorkspacePrivateHTTP(
    "http://jaeger.test",
    f.expected,
    c.options,
  );
  const archive = sourceArchive(c.directory);
  for (const sample of report.complete_source_receipt.samples)
    for (const query of sample.queries) {
      assert.deepEqual(readFileSync(join(archive, query.file)), bytes);
      assert.equal(query.bytes, bytes.length);
      assert.equal(
        query.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
});

test("HTTP read and manifest archive failures retain both original errors", async (t) => {
  const f = workspaceStateTraceFixture(),
    c = collectorFixture(t, f);
  const original = new Error("original HTTP source read failure");
  c.options.request = async () => {
    const manifest = join(sourceArchive(c.directory), "manifest.json");
    rmSync(manifest);
    mkdirSync(manifest);
    throw original;
  };
  await assert.rejects(
    implementation.collectWorkspacePrivateHTTP(
      "http://jaeger.test",
      f.expected,
      c.options,
    ),
    (error) => {
      const errors = originalErrors(error);
      assert(errors.includes(original));
      assert(
        errors.some(
          (entry) =>
            entry !== original &&
            entry.code === "ERR_ASSERTION" &&
            entry.message.includes("evidence output must be a regular file"),
        ),
      );
      return true;
    },
  );
});

test("terminal HTTP inspection failure retains the owning inspector errors", async (t) => {
  const f = workspaceStateTraceFixture(),
    c = collectorFixture(t, f);
  f.set(f.sql, "db.query.text", "SELECT 2");
  await assert.rejects(
    implementation.collectWorkspacePrivateHTTP(
      "http://jaeger.test",
      f.expected,
      c.options,
    ),
    (error) => {
      assert(
        originalErrors(error).some((entry) =>
          entry.stack.includes("inspectWorkspaceStateTrace"),
        ),
      );
      return true;
    },
  );
});

test("a failed export inspection may converge only after three later complete samples", async (t) => {
  const f = workspaceStateTraceFixture(),
    c = collectorFixture(t, f),
    request = c.options.request;
  const query = f.sql.tags.find((tag) => tag.key === "db.query.text").value;
  c.options.attempts = 4;
  c.options.request = async (...args) => {
    f.set(f.sql, "db.query.text", c.count() === 0 ? "SELECT 2" : query);
    return request(...args);
  };
  const report = await implementation.collectWorkspacePrivateHTTP(
    "http://jaeger.test",
    f.expected,
    c.options,
  );
  assert.equal(c.count(), 4);
  assert.deepEqual(
    report.complete_source_receipt.samples.map((sample) => sample.attempt),
    [2, 3, 4],
  );
  const manifest = JSON.parse(
    readFileSync(join(sourceArchive(c.directory), "manifest.json")),
  );
  assert.equal(manifest.attempts[0].status, "failed");
});

test("a damaged raw source preserves the private original receipt failure cause", async (t) => {
  const f = workspaceStateTraceFixture(),
    c = collectorFixture(t, f),
    request = c.options.request;
  c.options.request = async (...args) => {
    if (c.count() === 2)
      rmSync(join(sourceArchive(c.directory), "query-0001.raw"));
    return request(...args);
  };
  await assert.rejects(
    implementation.collectWorkspacePrivateHTTP(
      "http://jaeger.test",
      f.expected,
      c.options,
    ),
  );
  const failure = readFileSync(
    join(sourceArchive(c.directory), "complete-source-failure.private.txt"),
    "utf8",
  );
  assert(failure.includes("ENOENT") && failure.includes("query-0001.raw"));
});
for (const [kind, mode] of [
  ["private_state", "local-close"],
  ["private_state_watch", "local-close"],
  ["private_state_watch", "revocation"],
])
  test(`Workspace ${kind}/${mode} collector archives three complete original samples`, async (t) => {
    const f = workspaceStateTraceFixture(kind, mode),
      c = collectorFixture(t, f);
    assert.equal(typeof implementation.collectWorkspacePrivateHTTP, "function");
    const report = await implementation.collectWorkspacePrivateHTTP(
      "http://jaeger.test",
      f.expected,
      c.options,
    );
    assert.equal(c.count(), 3);
    assert.equal(report.topology, "passed");
    assert.equal(report.complete_source_receipt.stable_samples, 3);
    assert.deepEqual(report.complete_source_receipt.source_trace_ids, [
      f.trace.traceID,
    ]);
    const archive = join(
      c.directory,
      readdirSync(c.directory).find((name) =>
        name.startsWith("workspace-http-"),
      ),
    );
    const queries = readdirSync(archive).filter((name) =>
      name.endsWith(".raw"),
    );
    assert.equal(queries.length, 3);
    for (const file of queries)
      assert.deepEqual(
        JSON.parse(readFileSync(join(archive, file), "utf8")).data[0],
        f.trace,
      );
  });

for (const status of [200, 401])
  test(`Identity ${status} is independently collected with its own complete source receipt`, async (t) => {
    const f = workspaceAuthorityTraceFixture(status),
      c = collectorFixture(t, f);
    assert.equal(
      typeof implementation.collectWorkspaceAuthorityTrace,
      "function",
    );
    const report = await implementation.collectWorkspaceAuthorityTrace(
      "http://jaeger.test",
      f.expected,
      c.options,
    );
    assert.equal(c.count(), 3);
    assert.equal(report.complete_source_receipt.stable_samples, 3);
    assert.equal(report.status, status);
    assert.equal(report.strict_trace, status === 401 ? "failed" : "passed");
  });

test("a late original state error cannot borrow two earlier clean snapshots", async (t) => {
  const f = workspaceStateTraceFixture(),
    c = collectorFixture(t, f),
    request = c.options.request;
  c.options.request = async (...args) => {
    if (c.count() === 2) f.set(f.sql, "error", true);
    return request(...args);
  };
  assert.equal(typeof implementation.collectWorkspacePrivateHTTP, "function");
  await assert.rejects(
    implementation.collectWorkspacePrivateHTTP(
      "http://jaeger.test",
      f.expected,
      c.options,
    ),
  );
  assert.equal(c.count(), 3);
  const archive = join(
    c.directory,
    readdirSync(c.directory).find((name) => name.startsWith("workspace-http-")),
  );
  const raw = readFileSync(join(archive, "query-0003.raw"), "utf8");
  assert(raw.includes('"key":"error","value":true'));
});

test("the Workspace dispatcher uses the complete barrier gate with the original failure intact", async () => {
  const f = barrierTraceFixture();
  assert.equal(
    typeof implementation.inspectWorkspacePrivateRequest,
    "function",
  );
  const report = await implementation.inspectWorkspacePrivateRequest(
    f.trace,
    f.expected,
    [],
    [],
  );
  assert.equal(report.barrier_rejection, true);
  assert.equal(report.owned_error_spans.length, 2);
  assert.equal(report.kind, "request");
  assert.equal(report.method, f.expected.method);
  assert.equal(report.request_id, f.expected.requestId);
  assert.equal(report.session_id, f.expected.sessionId);
  assert.equal(report.connection_trace_id, f.expected.connectionTraceID);
  f.queries[0].duration = 50000;
  await assert.rejects(
    implementation.inspectWorkspacePrivateRequest(f.trace, f.expected, [], []),
  );
});

test("Workspace cancel notification carries actual source diagnostics and no invented request ID", async (t) => {
  const f = await cancelTraceFixture(t);
  assert.equal(
    typeof implementation.inspectWorkspacePrivateNotification,
    "function",
  );
  const report = implementation.inspectWorkspacePrivateNotification(
    f.trace,
    f.receipt,
    f.connection,
    [],
  );
  assert.equal(report.diagnostic_inventory_verified, true);
  assert.deepEqual(report.raw_error_inventory, []);
  assert.equal(report.method, "session/cancel");
  assert.equal(report.session_id, f.receipt.sessionId);
  assert.equal(report.connection_trace_id, f.receipt.connectionTraceID);
  assert.equal(report.request_id, undefined);
  f.connection.spans[0].tags.push({ key: "error", value: true });
  assert.throws(() =>
    implementation.inspectWorkspacePrivateNotification(
      f.trace,
      f.receipt,
      f.connection,
      [],
    ),
  );
});

test("the live Workspace entry preserves an early original business failure for later lifecycle collection", async () => {
  const { workspaceProtocol } = await import("./current-flow.mjs");
  const original = new Error("original Create failure"),
    events = [];
  const access = {
    snapshots: () => [],
    watchSnapshots: () => [],
    stateReceipts: () => [],
    authoritySnapshots: () => [],
    disconnectReceipts: () => [],
    notificationReceipts: () => [],
    async flush() {
      events.push("flush");
    },
    async closeAndWait() {
      events.push("join");
    },
  };
  const result = await workspaceProtocol(
    {
      config: { evidence: "unused" },
      traceSecrets: [],
      signal: new AbortController().signal,
      async command() {
        throw original;
      },
    },
    {
      createAccess: async () => access,
      readModel: async () => ({ requests: [], errors: [] }),
      flush: async () => {},
      persist: async () => {},
    },
  );
  assert.equal(result.profile, "workspace-protocol");
  assert(result.workspaceErrors.includes(original));
  assert.deepEqual(events, ["flush", "join"]);
});
