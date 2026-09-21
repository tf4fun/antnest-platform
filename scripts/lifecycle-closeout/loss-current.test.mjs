import assert from "node:assert/strict";
import { test } from "node:test";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import {
  stopLossRuntime,
  inspectLossDenial,
  readLossEvent,
} from "./loss-current.mjs";

test("loss audit reads current event fields with the owning database role", async () => {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    return '{"event_id":"event"}';
  };
  assert.deepEqual(await readLossEvent(docker, "postgres", "event"), {
    event_id: "event",
  });
  assert(calls[0].includes("antnest_agent_controller"));
  assert(!calls[0].at(-1).includes("admission_id"));
  assert(calls[0].at(-1).includes("operation_request_id, data"));
  await assert.rejects(readLossEvent(docker, "postgres", "unsafe'"));
  assert.equal(calls.length, 1);
});

test("Runtime removal requires an owned normal exit and never forces deletion", async () => {
  const project = "antnest-lifecycle-ab123456";
  const before = {
    Id: "runtime",
    State: { Running: true },
    Config: {
      Labels: {
        "io.antnest.runtime-controller-scope": project,
        "io.antnest.agent-id": "agent",
      },
    },
  };
  const initial = { container: before, agent: { agent_id: "agent" } };
  for (const exit of [0, 137]) {
    const calls = [];
    const docker = async (args) => {
      calls.push(args);
      return args[0] === "inspect"
        ? JSON.stringify([
            {
              ...before,
              State: { Running: false, ExitCode: exit, OOMKilled: false },
            },
          ])
        : "";
    };
    if (exit === 0) await stopLossRuntime(docker, before, initial, project);
    else
      await assert.rejects(stopLossRuntime(docker, before, initial, project));
    assert.deepEqual(calls, [
      ["stop", "-t", "10", "runtime"],
      ["inspect", "runtime"],
    ]);
  }
  await assert.rejects(
    stopLossRuntime(
      () => assert.fail("foreign mutation"),
      { ...before, Id: "foreign" },
      initial,
      project,
    ),
  );
});

function denied() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    requestId: "request-id",
    transport: "websocket",
    rejection: "agent_unavailable",
  });
  for (const span of f.trace.spans)
    span.tags.push({ key: "antnest.request.id", value: "request-id" });
  const request = f.trace.spans.find((s) => s.spanID === "request");
  request.tags.push(
    ...Object.entries({
      "rpc.response.status_code": -32020,
      "antnest.outcome": "rejected",
      "antnest.error.code": "-32020",
      error: true,
    }).map(([key, value]) => ({ key, value })),
  );
  f.add("denial", "request", "acp.session.prompt", undefined, 3, {
    "antnest.outcome": "rejected",
    "antnest.error.code": "agent_unavailable",
    error: true,
  });
  return f;
}
test("loss denial trace retains rejection errors while forbidding execution", () => {
  const f = denied();
  assert.equal(inspectLossDenial(f.trace, f.expected).strict_trace, "failed");
  for (const kind of ["agent.run", "model.complete", "mcp.tools.call"]) {
    const changed = denied();
    changed.add("effect", "request", kind);
    assert.throws(() => inspectLossDenial(changed.trace, changed.expected));
  }
  const wrong = denied();
  wrong.trace.spans
    .at(-1)
    .tags.find((t) => t.key === "antnest.error.code").value = "agent_busy";
  assert.throws(() => inspectLossDenial(wrong.trace, wrong.expected));
});
