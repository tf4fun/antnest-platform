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
  });
  try {
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
      if (observation.state.pending.includes(c.phase) && !cleanup.release) {
        cleanup.release = await release(stop.signal);
        assert(
          [200, 404].includes(cleanup.release.status),
          "owned cleanup release failed",
        );
      }
      const row = await audit(stop.signal);
      cleanup.audits.push(row);
      assert.equal(row.body.run_id, c.run_id);
      assert.equal(row.body.session_id, c.session_id);
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
