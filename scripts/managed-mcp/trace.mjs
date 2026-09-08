import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export async function verifyTraces(base, requests, secrets = []) {
  const evidence = [];
  const traceIDs = [...new Set(requests.map((request) => request.trace_id))];
  for (const id of traceIDs) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`${base}/api/traces/${id}`, {
          signal: AbortSignal.timeout(5000),
        });
        const trace = (await response.json()).data?.[0];
        evidence.push(
          inspectTrace(
            trace,
            requests.filter((request) => request.trace_id === id),
            secrets,
          ),
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (lastError) throw lastError;
  }
  return evidence;
}

export function inspectTrace(trace, requests, secrets = []) {
  assert(trace?.spans?.length, "trace not exported");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  const service = (span) => trace.processes[span.processID].serviceName;
  const ancestors = (span) => {
    const result = [];
    const seen = new Set();
    while (span && !seen.has(span.spanID)) {
      seen.add(span.spanID);
      result.push(span);
      span = spans.get(
        span.references?.find((ref) => ref.refType === "CHILD_OF")?.spanID,
      );
    }
    return result;
  };
  const infos = trace.spans.filter(
    (span) =>
      span.operationName === "mcp.runtime.info" &&
      service(span) === "agent-acp-service",
  );
  const calls = trace.spans.filter(
    (span) =>
      span.operationName === "mcp.tools.call" &&
      service(span) === "agent-acp-service",
  );
  const lists = trace.spans.filter(
    (span) =>
      span.operationName === "mcp.tools.list" &&
      service(span) === "agent-acp-service",
  );
  assert(infos.length > 0 && calls.length > 0, "missing ACP Runtime spans");
  for (const span of [...infos, ...lists, ...calls])
    assert(
      ancestors(span).some((parent) => service(parent) === "edge-gateway"),
      `missing Gateway ancestry: ${span.operationName}`,
    );
  const runtimes = trace.spans.filter(
    (span) => service(span) === "antnest-runtime",
  );
  for (const upstream of [...infos, ...lists, ...calls])
    assert(
      runtimes.some(
        (span) =>
          span.spanID !== upstream.spanID &&
          ancestors(span).some((parent) => parent.spanID === upstream.spanID),
      ),
      `missing Runtime child span: ${upstream.operationName}`,
    );
  const phases = verifyPreparations(spans, service, infos, lists, requests);
  const encoded = JSON.stringify(trace);
  assertSecretFree(encoded, secrets);
  for (const secret of [
    "managed-env-canary",
    "managed-model-test",
    "Managed workspace guidance version",
    "PRIVATE_SKILL_BODY_NOT_FOR_INITIAL_CONTEXT",
  ])
    assert(!encoded.includes(secret), "sensitive context in trace");
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    information_reads: infos.length,
    catalog_reads: lists.length,
    tool_calls: calls.length,
    phases,
    gateway_ancestry: true,
    services: [...new Set(trace.spans.map(service))].sort(),
  };
}

function verifyPreparations(spans, service, infos, lists, requests) {
  assert(requests?.length, "model request correlation missing");
  const tag = (span, key) => span.tags?.find((item) => item.key === key)?.value;
  const phases = new Map();
  for (const request of requests) {
    const model = spans.get(request.model_span_id);
    assert(
      model?.operationName === "model.complete" &&
        service(model) === "agent-acp-service",
      "model span missing",
    );
    const admission = tag(model, "admission.id");
    assert(admission, "model admission missing");
    const prior = phases.get(request.phase);
    assert(
      !prior || prior === admission,
      "one prompt created multiple admissions",
    );
    phases.set(request.phase, admission);
    for (const [kind, candidates] of [
      ["information", infos],
      ["catalog", lists],
    ]) {
      const prepared = candidates.filter(
        (span) => tag(span, "admission.id") === admission,
      );
      assert.equal(
        prepared.length,
        1,
        `missing fresh ${kind} for ${request.phase}`,
      );
      assert(
        prepared[0].startTime + prepared[0].duration <= model.startTime,
        `${kind} was not prepared before model request`,
      );
    }
  }
  assert.equal(
    new Set(phases.values()).size,
    phases.size,
    "different prompts reused admission",
  );
  assert.equal(infos.length, phases.size, "unexpected information read count");
  assert.equal(lists.length, phases.size, "unexpected catalog read count");
  return [...phases.keys()];
}
