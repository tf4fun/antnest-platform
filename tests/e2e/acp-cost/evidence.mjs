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

export function assertOperationUpdates(
  name,
  params,
  result,
  updates,
  owned = new Map(),
) {
  const target = ["new", "fork"].includes(name)
    ? result.sessionId
    : params.sessionId;
  assert(
    operationUpdates(updates, target, owned).every(
      (update) => target && update.sessionId === target,
    ),
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
    if (expected[index].trace_id)
      assert.equal(
        request.trace_id,
        expected[index].trace_id,
        "Provider trace mismatch",
      );
    else
      assert(
        expected[index].requestId && expected[index].connectionTraceID,
        "actual WebSocket request identity missing",
      );
    assert(request.trace_id, "Provider trace missing");
    assert(
      request.model_span_id && !ids.has(request.model_span_id),
      "missing or duplicate Provider span",
    );
    ids.add(request.model_span_id);
  }
}

export function assertObserverIsolation(updates, baseline, sessionId, modeId) {
  assert.deepEqual(
    updates.slice(0, baseline.length),
    baseline,
    "observer history changed",
  );
  for (const item of updates.slice(baseline.length)) {
    assert.equal(item.sessionId, sessionId, "foreign Session reached observer");
    if (item.update.sessionUpdate === "current_mode_update") {
      assert(modeId, "observer mode baseline missing");
      assert.equal(item.update.currentModeId, modeId, "observer mode changed");
    } else {
      assert.equal(
        item.update.sessionUpdate,
        "config_option_update",
        "observer received non-configuration output",
      );
      assertModelSelection(item.update, "agent_default");
    }
  }
}

// Catalog publication refreshes every attached Session. Only unchanged public
// configuration of a known owned Session can be separated from an operation.
export function operationUpdates(updates, target, owned) {
  return updates.filter((item) => {
    const baseline = owned.get(item.sessionId);
    if (item.sessionId === target || !baseline) return true;
    if (item.update.sessionUpdate === "config_option_update") {
      assertModelSelection(item.update, baseline.model);
      return false;
    }
    if (item.update.sessionUpdate === "current_mode_update") {
      assert(baseline.mode, "owned mode baseline missing");
      assert.equal(item.update.currentModeId, baseline.mode);
      return false;
    }
    return true;
  });
}

export function rememberSelection(owned, name, params, result) {
  const sessionId = ["new", "fork"].includes(name)
    ? result.sessionId
    : params.sessionId;
  if (!sessionId || !result.configOptions) return;
  owned.set(sessionId, {
    model: result.configOptions.find((o) => (o.id ?? o.configId) === "model")
      ?.currentValue,
    mode:
      result.modes?.currentModeId ??
      owned.get(sessionId)?.mode ??
      owned.get(params.sessionId)?.mode,
  });
}
