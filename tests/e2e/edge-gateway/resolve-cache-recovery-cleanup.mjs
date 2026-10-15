import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// A failed scenario may leave a durable Run after its browser transports close.
// Join that owned work before collecting closures, using a separate finite
// cleanup budget even when the caller has been interrupted.
export async function joinRecoveryRun({
  c,
  model,
  release,
  audit,
  lookupIntent,
  signal,
  timeoutMS = 10000,
  wait = delay,
}) {
  assert(Number.isFinite(timeoutMS) && timeoutMS > 0 && timeoutMS <= 15000);
  const stop = new AbortController();
  const timer = setTimeout(
    () => stop.abort(new Error("recovery Run cleanup timed out")),
    timeoutMS,
  );
  const cleanup = (c.failure_cleanup = {
    status: "joining",
    caller_aborted: signal?.aborted === true,
    started_at: performance.now(),
    model_observations: [],
    audits: [],
    intent_receipts: [],
  });
  try {
    // The HTTP202 can be durable before the first SSE acceptance event. Query
    // only that known intent; never repeat the prompt or choose a latest Run.
    while (!c.run_id) {
      stop.signal.throwIfAborted();
      assert(
        typeof lookupIntent === "function",
        "accepted intent lookup missing",
      );
      const row = await lookupIntent(stop.signal);
      cleanup.intent_receipts.push(row);
      stop.signal.throwIfAborted();
      assert.equal(row.status, 200);
      assert.equal(row.method, "GET");
      assert.equal(
        row.path,
        `/api/app/workspace/v1/agents/${encodeURIComponent(c.agent_id)}/sessions/${encodeURIComponent(c.session_id)}/operations/${encodeURIComponent(c.intent_id)}`,
      );
      const receipt = row.body;
      assert.equal(receipt.operationId, c.intent_id);
      assert.equal(receipt.sessionId, c.session_id);
      assert(["bridge", "unknown", "acp"].includes(receipt.acceptance));
      if (receipt.acceptance === "acp") {
        assert(typeof receipt.runId === "string" && receipt.runId.length > 0);
        assert(
          Number.isSafeInteger(receipt.outputWatermark) &&
            receipt.outputWatermark >= 0,
        );
        c.run_id = receipt.runId;
      } else {
        assert(
          ["dispatching", "uncertain"].includes(receipt.phase),
          "intent cannot prove accepted work",
        );
        await wait(250, undefined, { signal: stop.signal });
      }
    }
    const originals = (c.model_started?.state.requests ?? []).filter(
      (r) => r.phase === c.phase,
    );
    assert(originals.length <= 1);
    let original = originals[0];
    if (original) {
      assert.equal(original.trace_id, c.prompt.trace_id);
      cleanup.baseline_source = "business-status";
    }
    for (;;) {
      stop.signal.throwIfAborted();
      const observation = await model(stop.signal);
      cleanup.model_observations.push(observation);
      stop.signal.throwIfAborted();
      const requests = observation.state.requests.filter(
        (r) => r.phase === c.phase,
      );
      assert(requests.length <= 1);
      if (original || observation.state.pending.includes(c.phase))
        assert.equal(requests.length, 1);
      if (requests.length) {
        const request = requests[0];
        assert.equal(request.stage, "reply");
        assert.equal(request.trace_id, c.prompt.trace_id);
        assert.match(request.model_span_id ?? "", /^[a-f0-9]{16}$/u);
        assert(Number.isFinite(request.received_at_ms));
        if (!original) {
          original = structuredClone(request);
          cleanup.baseline_source = "cleanup-status";
          cleanup.baseline = original;
        }
        for (const key of ["trace_id", "model_span_id", "received_at_ms"])
          assert.equal(
            request[key],
            original[key],
            "cleanup model ownership differs",
          );
      }
      const row = await audit(stop.signal);
      cleanup.audits.push(row);
      stop.signal.throwIfAborted();
      assert.equal(row.body.run_id, c.run_id);
      assert.equal(row.body.session_id, c.session_id);
      assert.equal(row.body.agent_id, c.agent_id);
      assert.equal(row.body.principal_id, c.owner_id);
      if (observation.state.pending.includes(c.phase) && !cleanup.release) {
        cleanup.release = await release(stop.signal);
        stop.signal.throwIfAborted();
        assert(
          [200, 404].includes(cleanup.release.status),
          "owned cleanup release failed",
        );
        // The ownership check precedes the write; a later audit must prove
        // quiescence after it. Never join using this pre-release observation.
        continue;
      }
      if (
        ["completed", "cancelled", "failed"].includes(row.body.state) &&
        row.body.executor_state === "quiescent"
      ) {
        assert.equal(row.body.tool_effect_state, "none");
        if (cleanup.release?.status === 404)
          assert.equal(
            row.body.state,
            "cancelled",
            "missing release requires actual concurrent cancellation",
          );
        cleanup.audit = row;
        cleanup.status = "joined";
        cleanup.at = performance.now();
        return cleanup;
      }
      await wait(250, undefined, { signal: stop.signal });
    }
  } catch (error) {
    cleanup.status = "failed";
    cleanup.error = error.message;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
