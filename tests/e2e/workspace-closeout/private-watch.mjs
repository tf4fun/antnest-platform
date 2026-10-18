import assert from "node:assert/strict";
import { createRequire } from "node:module";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { openShutdownPrivateWatch } from "../lifecycle-closeout/shutdown-private-watch.mjs";
import { until } from "./state.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const validateState = new Ajv2020({ strict: false }).compile(schema);
const path = "/rpc/agent-acp/watch-agent-execution-state";

// Reuse the raw HTTP reader and its cleanup, not Shutdown's acceptance rules.
export async function openWorkspacePrivateWatch(agentId, browser, options) {
  let revocationStart;
  const withBoundary = (value) => ({
    ...value,
    revocation_start: revocationStart ? structuredClone(revocationStart) : null,
  });
  const transport = await openShutdownPrivateWatch(agentId, browser, {
    ...options,
    preserve: (value) => options.preserve(withBoundary(value)),
  });
  const states = [];
  function observed() {
    const actual = transport.events;
    assert(
      actual.length >= states.length,
      "Workspace state inventory moved backwards",
    );
    for (let index = 0; index < states.length; index++)
      assert.deepEqual(
        actual[index],
        states[index],
        "Workspace state history changed",
      );
    for (const value of actual.slice(states.length))
      states.push(Object.freeze(value));
    return states;
  }
  const watch = Object.create(transport);
  watch.snapshot = () => withBoundary(transport.snapshot());
  watch.closeAndWait = async () => withBoundary(await transport.closeAndWait());
  Object.defineProperty(watch, "states", { get: () => [...observed()] });
  watch.beginRevocation = () => {
    options.signal?.throwIfAborted();
    assert(!revocationStart, "Workspace revocation already observed");
    transport.assertOpen();
    const before = observed();
    assert(
      before.length > 0 && before.every((state) => state.access_allowed),
      "Workspace was already denied before revocation",
    );
    revocationStart = Object.freeze({
      traceID: transport.traceID,
      clientSpanID: transport.clientSpanID,
      observedAt: Date.now(),
      receivedEvents: before.length,
    });
    return revocationStart;
  };
  watch.wait = (predicate, after = 0) => {
    assert.equal(typeof predicate, "function");
    assert(Number.isSafeInteger(after) && after >= 0);
    return until(
      async () => {
        options.signal?.throwIfAborted();
        const state = observed().slice(after).find(predicate);
        if (state) return state;
        if (transport.closure) {
          await transport.closeAndWait();
          throw new Error("Workspace watch ended before the expected state");
        }
        return undefined;
      },
      "private Workspace state",
      options.signal,
    );
  };
  return watch;
}

// The consumer must prove the original bytes and actual remote EOF separately.
// A parsed denied state followed by local cancellation is not revocation EOF.
export function assertWorkspaceWatchReceipt(receipt, expected) {
  const remote = expected.mode === "revocation";
  assert(
    remote || expected.mode === "local-close",
    "unknown Workspace watch mode",
  );
  assert.equal(receipt.agentId, expected.agentID);
  assert.deepEqual(receipt.principal, expected.principal);
  for (const field of ["organization_id", "user_id"])
    assert(
      typeof receipt.principal[field] === "string" && receipt.principal[field],
    );
  assert.match(receipt.session_digest, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.session_digest, expected.session_digest);
  assert.equal(receipt.method, "POST");
  assert.equal(receipt.path, path);
  assert.deepEqual(receipt.request_body, {});
  assert.equal(receipt.traceID, expected.traceID);
  assert.equal(receipt.clientSpanID, expected.clientSpanID);
  assert.match(receipt.traceID, /^[a-f0-9]{32}$/u);
  assert.match(receipt.clientSpanID, /^[a-f0-9]{16}$/u);
  assert.equal(receipt.status, 200);
  assert(/^text\/event-stream(?:\s*;|$)/iu.test(receipt.content_type));
  if (receipt.response_trace_id != null)
    assert.equal(receipt.response_trace_id, receipt.traceID);
  assert.equal(receipt.joined, true);
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.terminal_events, []);
  assert.equal(receipt.body_outcome, remote ? "eof" : "cancelled");
  const raw = Buffer.from(receipt.raw_body_base64, "base64");
  assert.equal(raw.toString("base64"), receipt.raw_body_base64);
  assert.equal(raw.length, receipt.body_bytes);
  assert(raw.length > 0 && raw.length <= 1024 * 1024);
  const parts = new TextDecoder("utf-8", { fatal: true })
    .decode(raw)
    .split(/\r?\n\r?\n/u);
  assert.equal(parts.pop(), "", "incomplete original Workspace state frame");
  const events = [];
  for (const part of parts) {
    assert(
      events.at(-1)?.access_allowed !== false,
      "Workspace event after terminal denial",
    );
    const match = /^event: workspace_state\r?\ndata: ([^\r\n]*)$/u.exec(part);
    assert(match, "unexpected original Workspace state frame");
    const value = JSON.parse(match[1]);
    assert(
      validateState(value),
      "invalid complete original Workspace state schema",
    );
    assert.equal(value.agent_id, expected.agentID);
    if (!value.access_allowed)
      assert.deepEqual(
        value,
        {
          agent_id: expected.agentID,
          access_allowed: false,
          availability: "offline",
          active_session_id: null,
          configuration_revision: null,
          unavailable_reason: "access_denied",
        },
        "Workspace denial must be the complete sanitized state",
      );
    events.push(value);
  }
  assert(events.length > 0 && events.length < 100);
  assert.equal(
    events[0].access_allowed,
    true,
    "watch was not originally authorized",
  );
  assert.equal(events[0].availability, "ready");
  assert.equal(events[0].active_session_id, null);
  assert.equal(events[0].unavailable_reason, null);
  assert.deepEqual(receipt.events, events);
  assert.equal(receipt.closure.kind, remote ? "transport-end" : "local-close");
  assert.equal(receipt.closure.traceID, receipt.traceID);
  assert.equal(receipt.closure.clientSpanID, receipt.clientSpanID);
  assert.equal(receipt.closure.receivedEvents, events.length);
  const { start, end } = expected.window;
  assert([start, end, receipt.closure.observedAt].every(Number.isSafeInteger));
  assert(start >= 0 && start <= end);
  assert(
    receipt.closure.observedAt >= start && receipt.closure.observedAt <= end,
    "Workspace closure outside its observed window",
  );
  if (remote) {
    assert.match(expected.revocationTraceID, /^[a-f0-9]{32}$/u);
    const baseline = receipt.revocation_start;
    assert(
      baseline,
      "Workspace revocation lacks its original authorized boundary",
    );
    assert.deepEqual(baseline, expected.revocationStart);
    assert.equal(baseline.traceID, receipt.traceID);
    assert.equal(baseline.clientSpanID, receipt.clientSpanID);
    assert.equal(baseline.observedAt, start);
    assert(
      Number.isSafeInteger(baseline.receivedEvents) &&
        baseline.receivedEvents > 0 &&
        baseline.receivedEvents < events.length,
    );
    assert(
      events
        .slice(0, baseline.receivedEvents)
        .every((state) => state.access_allowed),
      "Workspace denial preceded the revocation boundary",
    );
    assert.equal(
      events.at(-1).access_allowed,
      false,
      "Workspace remote EOF lacks its terminal denial",
    );
  } else
    assert(
      events.every((state) => state.access_allowed),
      "local watch borrowed a revocation state",
    );
  return events;
}
