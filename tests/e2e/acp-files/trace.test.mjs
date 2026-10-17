import { fixture, execution } from "./trace-fixtures.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { inspectFileTrace, inspectReplayRequestTrace } from "./trace.mjs";
import { commandStrictOutcome } from "../acp-commands/trace.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import {
  addReadEndpointObservation,
  assertReadEndpointObservations,
  scaleReadFixtureTrace,
} from "../observability/runtime-information-timing-fixture.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

for (const failed of [false, true])
  test(`file owning diagnostics reach clock admission without a raw inventory collision (failed=${failed})`, () => {
    const { trace, requests } = execution(
      failed ? "v2-failed-edit" : "v1-create",
    );
    if (failed) trace.spans.at(-1).tags.push({ key: "error", value: true });
    trace.warnings = [
      "clock skew adjustment disabled; not applying calculated delta of 3µs",
    ];
    const raw = JSON.stringify(trace);
    const result = inspectFileTrace(trace, requests);
    assert.equal(commandStrictOutcome([result]).accepted, true);
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.reviewed_error_spans.length, failed ? 1 : 0);
    assert.equal(JSON.stringify(trace), raw);
    const before = JSON.stringify(result);
    commandStrictOutcome([result]);
    assert.equal(JSON.stringify(result), before);
    assert.equal(
      commandStrictOutcome([{ ...result, warnings: ["unknown warning"] }])
        .accepted,
      false,
    );
    for (const mutate of [
      (value) => value.spans[0].tags.push({ key: "error", value: true }),
      (value) => {
        value.spans[2].references[0].spanID = "missing";
      },
    ]) {
      const bad = structuredClone(trace);
      mutate(bad);
      assert.throws(() => inspectFileTrace(bad, requests));
    }
  });

test("files correlate actual model HTTP, Run and Runtime dispatch without admissions", () => {
  const { trace, requests } = execution();
  assert.equal(inspectFileTrace(trace, requests).runtime_tool_calls, 1);
  for (const mutate of [
    (t) => {
      t.spans.find((s) => s.spanID === "model").references[0].spanID = "prompt";
    },
    (t) => {
      t.spans.find((s) => s.spanID === "call").tags[0].value = "wrong";
    },
    (t) => {
      t.spans.find((s) => s.spanID === "info").startTime =
        t.spans.find((s) => s.spanID === "model").startTime + 5000;
    },
    (t) =>
      t.spans.push({
        ...structuredClone(t.spans.at(-1)),
        spanID: "duplicate-tool",
      }),
  ]) {
    const bad = structuredClone(trace);
    mutate(bad);
    assert.throws(() => inspectFileTrace(bad, requests));
  }
  assert.throws(() =>
    inspectFileTrace(trace, [{ ...requests[0], model_span_id: "model" }]),
  );
});
test("only deliberate failed-edit Tool errors are allowed; warnings keep strict failure", () => {
  const { trace, requests } = execution("v2-failed-edit");
  trace.spans.at(-1).tags.push({ key: "error", value: true });
  assert.equal(inspectFileTrace(trace, requests).strict_trace, "passed");
  assert.throws(() =>
    inspectFileTrace(trace, [{ ...requests[0], phase: "v2-create" }]),
  );
  trace.spans[0].warnings = ["clock skew adjustment disabled"];
  assert.equal(inspectFileTrace(trace, requests).strict_trace, "failed");
  trace.spans[0].tags.push({ key: "error", value: true });
  assert.throws(() => inspectFileTrace(trace, requests));
});
test("replay verifies each independent message trace, exact session and socket link", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const { trace, add } = fixture(method);
    const expected = {
      method,
      sessionId: "session",
      connectionTraceID: "connection",
    };
    assert.equal(inspectReplayRequestTrace(trace, expected).no_execution, true);
    for (const mutate of [
      (t) => {
        t.spans[0].references = [];
      },
      (t) => {
        t.spans[2].tags.find((x) => x.key === "antnest.session.id").value =
          "foreign";
      },
      (t) => {
        t.spans[2].references[0].spanID = "missing";
      },
      (t) => t.spans[2].tags.push({ key: "error", value: true }),
      (t) => t.spans[2].tags.push({ key: "captured", value: "private-canary" }),
    ]) {
      const bad = structuredClone(trace);
      mutate(bad);
      assert.throws(() =>
        inspectReplayRequestTrace(bad, expected, ["private-canary"]),
      );
    }
    trace.spans[0].warnings = ["clock skew adjustment disabled"];
    assert.equal(
      inspectReplayRequestTrace(trace, expected).strict_trace,
      "failed",
    );
    add("unexpected", "prompt", "agent.run", "agent-acp-service", 3);
    assert.throws(() => inspectReplayRequestTrace(trace, expected));
  }
});
test("replay may read the Skill catalog but never call executable Runtime methods", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    for (const rpc of ["resources/read", "tools/call"]) {
      const { trace } = fixture(method);
      const request = trace.spans.find((span) => span.spanID === "prompt");
      request.duration = 100;
      setTag(request, "antnest.agent.id", "agent");
      const catalog = addCompletedRead(trace, request, "ws", "agent", {
        preserveRequest: true,
        runtimeOutcome: "success",
        clientOutcome: "success",
      });
      setTag(catalog.server, "rpc.method", rpc);
      setTag(catalog.operation, "rpc.method", rpc);
      const expected = {
        method,
        sessionId: "session",
        connectionTraceID: "connection",
      };
      if (rpc === "tools/call")
        assert.throws(() => inspectReplayRequestTrace(trace, expected));
      else
        assert.equal(
          inspectReplayRequestTrace(trace, expected).runtime_information_reads,
          1,
        );
    }
  }
});

test("file replay exports its original catalog endpoint observation", () => {
  const { trace } = fixture("session/load");
  const request = trace.spans.find((span) => span.spanID === "prompt");
  request.duration = 100;
  setTag(request, "antnest.agent.id", "agent");
  const catalog = addCompletedRead(trace, request, "ws", "agent", {
    preserveRequest: true,
    runtimeOutcome: "success",
    clientOutcome: "success",
  });
  const requestExpectation = {
    method: "session/load",
    sessionId: "session",
    connectionTraceID: "connection",
  };
  scaleReadFixtureTrace(trace);
  const baseline = inspectReplayRequestTrace(trace, requestExpectation);
  const expected = addReadEndpointObservation(trace, catalog.read);
  const raw = structuredClone(trace);
  assertReadEndpointObservations(
    inspectReplayRequestTrace(trace, requestExpectation),
    [expected],
    baseline,
  );
  assert.deepEqual(trace, raw);
});
