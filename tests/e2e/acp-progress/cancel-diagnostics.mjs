import { setTimeout as delay } from "node:timers/promises";

// The diagnostic line goes to a public CI log, so it carries only fixed,
// payload-free span fields and frame transitions, never content or messages.
const reportedTags = new Set([
  "span.kind",
  "rpc.method",
  "antnest.operation.phase",
  "antnest.outcome",
  "antnest.error.code",
  "antnest.error.type",
  "error.type",
  "otel.status_code",
  "executor.exit.classification",
  "http.status_code",
  "http.response.status_code",
]);

export function summarizeSpans(trace, originUs) {
  const processes = trace?.processes ?? {};
  return (trace?.spans ?? [])
    .map((span) => ({
      service: processes[span.processID]?.serviceName,
      operation: span.operationName,
      start_ms: Math.round((span.startTime - originUs) / 1000),
      duration_ms: Math.round(span.duration / 1000),
      ...Object.fromEntries(
        (span.tags ?? [])
          .filter(({ key }) => reportedTags.has(key))
          .map(({ key, value }) => [key, value]),
      ),
    }))
    .sort((a, b) => a.start_ms - b.start_ms);
}

export function summarizeFrames(frames) {
  return frames
    .map((frame) => frame.update)
    .filter((update) =>
      ["tool_call", "tool_call_update", "state_update"].includes(
        update?.sessionUpdate,
      ),
    )
    .map((update) => ({
      update: update.sessionUpdate,
      ...(update.status ? { status: update.status } : {}),
      ...(update.state ? { state: update.state } : {}),
      ...(update.stopReason ? { stop_reason: update.stopReason } : {}),
    }));
}

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Explains a missed cancellation deadline without changing it: whether the
// process stopped late or never, what the client saw, and how the prompt and
// session/cancel requests were traced. Collection failures are reported.
export async function cancelDiagnostics({
  jaeger,
  model,
  phase,
  cancelAt,
  frames,
  stopped,
  lateBudgetMs = 30_000,
  pollMs = 250,
  fetchJSON = getJSON,
}) {
  const errors = [];
  const attempt = async (step, action) => {
    try {
      return await action();
    } catch (error) {
      errors.push({ step, error: error?.name ?? "Error" });
      return undefined;
    }
  };
  const stoppedAfterMs = await attempt("late_stop", async () => {
    const deadline = Date.now() + lateBudgetMs;
    while (Date.now() < deadline) {
      if (await stopped()) return Date.now() - cancelAt;
      await delay(pollMs);
    }
    return null;
  });
  const originUs = cancelAt * 1000;
  const traces = [];
  await attempt("prompt_trace", async () => {
    const status = await fetchJSON(`${model}/status`);
    const id = status.requests.find(
      (request) => request.phase === phase,
    )?.trace_id;
    if (!id) throw new Error("prompt trace ID missing");
    const trace = (await fetchJSON(`${jaeger}/api/traces/${id}`)).data?.[0];
    traces.push({ kind: "prompt", spans: summarizeSpans(trace, originUs) });
  });
  await attempt("cancel_trace", async () => {
    const query = new URLSearchParams({
      service: "agent-acp-service",
      tags: JSON.stringify({ "rpc.method": "session/cancel" }),
      start: String(originUs - 5_000_000),
      end: String(Date.now() * 1000),
      limit: "20",
    });
    for (const trace of (await fetchJSON(`${jaeger}/api/traces?${query}`))
      .data ?? [])
      traces.push({ kind: "cancel", spans: summarizeSpans(trace, originUs) });
  });
  return {
    phase,
    diagnostic: "cancel_timeout",
    stopped_after_ms: stoppedAfterMs ?? null,
    frames: summarizeFrames(frames),
    traces,
    errors,
  };
}
