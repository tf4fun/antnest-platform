import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../acp-commands/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
const url = new URL("./restore-private-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function collect(t, change = () => {}) {
  assert.equal(typeof implementation.collectPrivateRestoreTrace, "function");
  const f = privateBoundaryFixture(fixture("ordinary"), { version: 1 });
  f.expected.runId = "run";
  const directory = mkdtempSync(join(tmpdir(), "restore-private-trace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = { ...f.expected };
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  change(f, expected);
  let observations = 0;
  const result = await implementation.collectPrivateRestoreTrace(
    "http://jaeger",
    expected,
    {
      directory,
      requests: f.requests,
      attempts: 4,
      wait: async () => {},
      flush: async () => {},
      async request(address) {
        const path = new URL(address).pathname;
        if (path === "/api/traces/" + f.connectionTrace.traceID) {
          observations++;
          return Response.json({ data: [f.connectionTrace] });
        }
        if (path === "/api/v3/trace-summaries")
          return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
        assert.equal(path, "/api/traces/" + f.trace.traceID);
        return Response.json({ data: [f.trace] });
      },
    },
  );
  return { f, result, observations };
}
test("Restore binds the ordinary Tool Run to its private original request and archives complete evidence", async (t) => {
  const { f, result, observations } = await collect(t);
  assert.equal(observations, 3);
  assert.equal(result.run_id, "run");
  assert.equal(result.runtime_tool_calls, 1);
  assert.equal(result.connection_trace_id, f.expected.connectionTraceID);
  assert.equal(implementation.restorePrivateOutcome([result]).accepted, true);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(result.evidence_directory, "request.json"), "utf8"),
    ),
    f.trace,
  );
});
test("Restore cannot borrow semantic denial allowances or another public Run", async (t) => {
  for (const mutate of [
    (f, expected) => {
      expected.rejection = "agent_busy";
    },
    (f, expected) => {
      expected.rejection = "agent_unavailable";
    },
    (f, expected) => {
      expected.runId = "foreign";
    },
    (f) => {
      f.connectionTrace.spans[0].tags.push({
        key: "exception.message",
        value: "unknown internal failure",
      });
    },
  ])
    await assert.rejects(collect(t, mutate));
});
