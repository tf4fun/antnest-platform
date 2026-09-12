import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export function assertPublicFrames(frames) {
  const privateKeys = new Set([
    "measurement",
    "receipt",
    "pricing",
    "input_per_million",
    "inputPerMillion",
    "output_per_million",
    "outputPerMillion",
  ]);
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert(!privateKeys.has(key), "private accounting field on ACP wire");
      assert(
        !(
          key === "source" && ["provider_reported", "estimated"].includes(child)
        ),
        "private receipt source on ACP wire",
      );
      inspect(child);
    }
  };
  for (const frame of frames) inspect(frame);
  assertSecretFree(JSON.stringify(frames), ["cost-model-test"]);
}

export function assertOperationUpdates(name, params, result, updates) {
  const target = ["new", "fork"].includes(name)
    ? result.sessionId
    : params.sessionId;
  assert(
    updates.every((update) => target && update.sessionId === target),
    `unexpected Session notification during ${name}`,
  );
}

export function assertModelSelection(result, expected) {
  assert.equal(
    result.configOptions?.find(
      (option) => (option.id ?? option.configId) === "model",
    )?.currentValue,
    expected,
    "restored model selection mismatch",
  );
}

export function usageUpdates(updates, sessionId) {
  assert(
    updates.every((item) => item.sessionId === sessionId),
    "foreign Session notification",
  );
  return updates
    .filter(
      (item) =>
        item.sessionId === sessionId &&
        item.update.sessionUpdate === "usage_update",
    )
    .map((item) => item.update);
}

export function assertCost(updates, sessionId, expected) {
  const costs = usageUpdates(updates, sessionId);
  assert.equal(costs.length, 1, "expected exactly one usage snapshot");
  const usage = costs[0];
  assert.deepEqual(
    Object.keys(usage).sort(),
    [
      "sessionUpdate",
      "used",
      "size",
      ...(expected === undefined ? [] : ["cost"]),
    ].sort(),
    "private or missing usage fields",
  );
  assert.equal(usage.used, 1100);
  assert.equal(usage.size, 64000);
  if (expected !== undefined) {
    assert.deepEqual(Object.keys(usage.cost).sort(), ["amount", "currency"]);
    assert.equal(usage.cost.currency, "USD");
    assert(
      Number.isFinite(usage.cost.amount) &&
        Math.abs(usage.cost.amount - expected) < 1e-12,
      "wrong cumulative cost",
    );
  }
  return structuredClone(usage);
}

export function assertAttempts(actual, expected) {
  assert.equal(
    actual.length,
    expected.length,
    "Provider attempt count mismatch",
  );
  const ids = new Set();
  for (let index = 0; index < actual.length; index++) {
    const request = actual[index];
    assert.equal(
      request.phase,
      expected[index].phase,
      "Provider phase mismatch",
    );
    assert.equal(
      request.trace_id,
      expected[index].trace_id,
      "Provider trace mismatch",
    );
    assert(
      request.model_span_id && !ids.has(request.model_span_id),
      "missing or duplicate Provider span",
    );
    ids.add(request.model_span_id);
  }
}

export function inspectPricingTrace(trace, secrets = []) {
  assert(trace?.spans?.length, "pricing trace missing");
  const spans = new Map(trace.spans.map((s) => [s.spanID, s]));
  const service = (s) => trace.processes[s.processID]?.serviceName;
  const controller = trace.spans.filter(
    (s) => service(s) === "agent-controller",
  );
  assert(controller.length, "Controller price authority missing");
  for (let span of controller) {
    const chain = [],
      seen = new Set();
    while (span) {
      assert(!seen.has(span.spanID), "cyclic pricing ancestry");
      seen.add(span.spanID);
      chain.push(service(span));
      const parent = span.references?.find(
        (r) => r.refType === "CHILD_OF" && r.traceID === trace.traceID,
      );
      span = spans.get(parent?.spanID);
    }
    assert(
      chain.indexOf("admin-console") > 0 &&
        chain.indexOf("edge-gateway") > chain.indexOf("admin-console"),
      "missing Gateway/Console pricing ancestry",
    );
  }
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: trace.traceID,
    controller_spans: controller.length,
    gateway_console_ancestry: true,
  };
}
