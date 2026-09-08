import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { assertSecretFree } from "./evidence.mjs";

export function assertDisabled(agent, runtime, agentID) {
  assert(
    agent.agent_id === agentID &&
      agent.desired_state === "disabled" &&
      agent.lifecycle_state === "disabled",
    "Agent did not finish Disable",
  );
  assert(
    runtime.agent_id === agentID &&
      runtime.lifecycle_state === "disabled" &&
      runtime.health === "absent" &&
      !runtime.runtime_execution_id &&
      !runtime.mcp_endpoint,
    "Runtime is not independently confirmed disabled/absent",
  );
}

const key = (span) => `${span.traceID}/${span.spanID}`;
const tag = (span, name) => span.tags?.find((item) => item.key === name)?.value;

export function failureCategory(error) {
  if (error?.code === "ERR_ASSERTION") return "assertion_failed";
  if (error?.name === "TimeoutError") return "request_timeout";
  return "fixture_or_dependency_failed";
}

export function installFailureBoundary() {
  const fatal = (error) => {
    writeSync(
      2,
      JSON.stringify({
        event: "agent_access_failed",
        reason: failureCategory(error),
      }) + "\n",
    );
    // The coordinating shell owns container/volume cleanup, even on bootstrap failure.
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

export function inspectOffboardingTrace(traces, expected, secrets) {
  const spans = new Map();
  for (const trace of traces) {
    assertSecretFree(JSON.stringify(trace), secrets);
    for (const span of trace.spans ?? []) {
      assert.equal(span.traceID, trace.traceID, "mixed trace IDs");
      spans.set(key(span), {
        ...span,
        service: trace.processes[span.processID]?.serviceName,
      });
    }
  }
  // Follow exact parent/link IDs, never infer causality from service presence.
  function reaches(start, predicate, links = true) {
    const pending = [start],
      seen = new Set();
    while (pending.length) {
      const span = pending.pop();
      if (!span || seen.has(key(span))) continue;
      seen.add(key(span));
      if (predicate(span)) return true;
      for (const ref of span.references ?? []) {
        if (
          ref.refType === "CHILD_OF" ||
          (links && ref.refType === "FOLLOWS_FROM")
        )
          pending.push(spans.get(key(ref)));
      }
    }
    return false;
  }
  const source = [...spans.values()].filter(
    (span) => span.traceID === expected.sourceID,
  );
  const gateway = (span) =>
    span.traceID === expected.sourceID && span.service === "edge-gateway";
  const sourceIdentity = (span) =>
    span.traceID === expected.sourceID &&
    span.service === "identity-service" &&
    reaches(span, gateway, false);
  const schedule = source.find(
    (span) =>
      span.operationName === "agent_controller.identity_offboarding.disable" &&
      span.service === "agent-controller" &&
      tag(span, "agent.id") === expected.agentID &&
      reaches(span, sourceIdentity, false),
  );
  assert(
    schedule,
    "source Identity/Gateway -> matching Agent schedule ancestry missing",
  );
  assert(
    source.some(
      (span) =>
        span.operationName ===
          "agent_controller.identity_offboarding.receive" &&
        span.service === "agent-controller" &&
        reaches(span, sourceIdentity, false),
    ),
    "source revocation receipt missing",
  );
  const workers = [...spans.values()].filter(
    (span) =>
      span.service === "agent-controller" &&
      span.operationName === "recover Agent lifecycle operation" &&
      tag(span, "antnest.lifecycle.request_id") === expected.requestID &&
      tag(span, "antnest.lifecycle.kind") === "disable" &&
      tag(span, "antnest.agent.id") === expected.agentID,
  );
  const phases = ["drain", "network_fence", "runtime_disable", "publish"];
  for (const phase of phases) {
    const roots = workers.filter(
      (span) => tag(span, "antnest.lifecycle.phase") === phase,
    );
    assert(
      roots.length > 0 &&
        roots.every((span) =>
          reaches(span, (ancestor) => key(ancestor) === key(schedule)),
        ),
      `Disable ${phase} lacks exact source link`,
    );
    const dependency = {
      network_fence: {
        service: "antnest-runtime-egress",
        method: "PUT",
        route: "/internal/agent-network-attachments/{agent_id}",
      },
      runtime_disable: {
        service: "runtime-controller",
        method: "POST",
        route: "POST /internal/runtimes/{agent_id}/disable",
      },
    }[phase];
    if (dependency)
      assert(
        [...spans.values()].some(
          (span) =>
            span.service === dependency.service &&
            tag(span, "http.request.method") === dependency.method &&
            tag(span, "http.route") === dependency.route &&
            reaches(
              span,
              (ancestor) => roots.some((root) => key(root) === key(ancestor)),
              false,
            ),
        ),
        `${phase} lacks causal mutating ${dependency.service} RPC`,
      );
  }
  return {
    source_trace_id: expected.sourceID,
    agent_id: expected.agentID,
    request_id: expected.requestID,
    phases,
    traces: traces.length,
    spans: spans.size,
    gateway_ancestry: true,
  };
}

export async function verifyOffboardingTrace(base, expected, secrets) {
  let last;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const get = async (path) => {
        const response = await fetch(base + path, {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200, "Jaeger query failed");
        return (await response.json()).data ?? [];
      };
      const query = new URLSearchParams({
        service: "agent-controller",
        operation: "recover Agent lifecycle operation",
        tags: JSON.stringify({
          "antnest.lifecycle.request_id": expected.requestID,
        }),
        lookback: "1h",
        limit: "100",
      });
      const traces = await get(`/api/traces?${query}`);
      const source = await get(`/api/traces/${expected.sourceID}`);
      return inspectOffboardingTrace([...source, ...traces], expected, secrets);
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw last;
}
