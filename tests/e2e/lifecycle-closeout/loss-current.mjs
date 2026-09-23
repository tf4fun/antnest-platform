import assert from "node:assert/strict";
import { assertOwnedRuntime } from "./loss-evidence.mjs";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";

export async function readLossEvent(docker, postgres, eventID) {
  assert.match(eventID, /^[a-zA-Z0-9_-]+$/);
  const value = await docker([
    "exec",
    postgres,
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "antnest_agent_controller",
    "-d",
    "antnest_agent_controller",
    "-c",
    `SELECT row_to_json(e) FROM (SELECT event_id, global_sequence, agent_id, event_type,
      operation_request_id, data FROM agent_controller.agent_events WHERE event_id='${eventID}') e`,
  ]);
  return value ? JSON.parse(value) : null;
}

export async function stopLossRuntime(docker, target, initial, project) {
  assertOwnedRuntime(target, initial, project);
  await docker(["stop", "-t", "10", target.Id]);
  const stopped = JSON.parse(await docker(["inspect", target.Id]))[0];
  assert.equal(stopped.Id, target.Id);
  assert.equal(stopped.State.Running, false);
  assert.equal(
    stopped.State.ExitCode,
    0,
    "loss fixture Runtime did not exit normally",
  );
  assert.equal(stopped.State.OOMKilled, false);
}

export function inspectLossDenial(trace, expected, secrets = []) {
  assert.equal(expected.rejection, "agent_unavailable");
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  assert.equal(tag(request, "rpc.response.status_code"), -32020);
  assert.equal(tag(request, "antnest.outcome"), "rejected");
  assert(hasError(request));
  for (const span of trace.spans) {
    assert(!/^(agent\.run|model\.|mcp\.)/.test(span.operationName));
    assert.notEqual(tree.service(span), "antnest-runtime");
    if (!hasError(span)) continue;
    assert.equal(tree.service(span), "agent-acp-service");
    assert(tree.chain(span).includes(request));
    assert.equal(tag(span, "antnest.outcome"), "rejected");
    assert.equal(
      tag(span, "antnest.error.code"),
      span === request ? "-32020" : "agent_unavailable",
    );
    if (span !== request)
      assert.equal(span.operationName, "acp.session.prompt");
  }
  return strictSessionEvidence(
    {
      trace_id: trace.traceID,
      runs: 0,
      no_execution: true,
      rejection: expected.rejection,
      ...timingEvidence(trace, tree, request, forwarded),
    },
    trace,
  );
}
