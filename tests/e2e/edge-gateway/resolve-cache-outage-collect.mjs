import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectWorkspaceChatTrace } from "../workspace-closeout/chat-trace.mjs";
import { outagePhase } from "./resolve-cache-outage.mjs";

export function outageChatExpectation(evidence) {
  const observation = evidence.model_cancelled;
  assert(observation?.state, "actual outage model observation missing");
  assert.deepEqual(observation.state.errors, []);
  const requests = observation.state.requests.filter(
    (row) => row.phase === outagePhase,
  );
  assert.equal(requests.length, 2, "actual outage model pair missing");
  const prompts = evidence.http.filter((row) => row.label === "outage-prompt");
  assert.equal(prompts.length, 1, "actual outage prompt missing or duplicate");
  const prompt = prompts[0];
  assert.equal(prompt.method, "POST");
  assert.equal(
    prompt.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/sessions/${encodeURIComponent(evidence.session_id)}/prompts`,
  );
  assert.equal(prompt.status, 202);
  assert.equal(prompt.set_cookie_count, 0);
  assert.equal(prompt.body.acceptance, "bridge");
  for (const request of requests)
    assert.equal(
      request.trace_id,
      prompt.trace_id,
      "actual model differs from prompt Trace",
    );
  const audits = evidence.http.filter(
    (row) => row.trace_id === evidence.audit?.trace_id,
  );
  assert.equal(
    audits.length,
    1,
    "actual terminal audit observation absent or duplicate",
  );
  assert.deepEqual(
    audits[0],
    evidence.audit,
    "actual terminal audit observation changed",
  );
  return {
    traceID: prompt.trace_id,
    agentId: evidence.agent_id,
    sessionId: evidence.session_id,
    runId: evidence.run_id,
    bridge: true,
    phase: outagePhase,
    requests,
    audit: evidence.audit,
    cancelAt: evidence.cancel_at,
    resolveTTLMS: evidence.settings.resolveTTLMS,
  };
}

export function outageTraceSelection(evidence, found) {
  const ids = new Set(),
    connections = new Map();
  const add = (id) => {
    assert.match(id ?? "", /^[a-f0-9]{32}$/u);
    ids.add(id);
  };
  for (const row of evidence.http) add(row.trace_id);
  if (evidence.stream) add(evidence.stream.trace_id);
  for (const wire of [evidence.prep_wire, evidence.wire]) {
    if (!wire?.upgrade) continue;
    add(wire.upgrade.trace_id);
    const methods = wire.frames
      .filter((frame) => frame.direction === "send")
      .map((frame) => JSON.parse(frame.raw).method)
      .filter(Boolean)
      .sort();
    connections.set(wire.upgrade.trace_id, { expected: methods, actual: [] });
  }
  for (const observation of evidence.model_observations)
    for (const request of observation.state.requests) add(request.trace_id);
  const observed = new Set();
  for (const trace of found.messages) {
    assert(
      !observed.has(trace.traceID),
      "duplicate message Trace search entry",
    );
    observed.add(trace.traceID);
    const tree = traceTopology(trace);
    const root = trace.spans.find((span) => !tree.parent(span));
    const owner = root?.references.find(
      (ref) => ref.refType === "FOLLOWS_FROM" && connections.has(ref.traceID),
    );
    if (!owner) continue;
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    connections.get(owner.traceID).actual.push(tag(root, "rpc.method"));
    add(trace.traceID);
  }
  for (const { expected, actual } of connections.values())
    assert.deepEqual(
      actual.sort(),
      expected,
      "actual WSS message Trace inventory differs from wire",
    );
  const causal = new Set(ids);
  for (const trace of found.refresh) {
    const tree = traceTopology(trace),
      root = trace.spans.find((span) => !tree.parent(span));
    if (
      root?.references.some(
        (ref) => ref.refType === "FOLLOWS_FROM" && causal.has(ref.traceID),
      )
    )
      add(trace.traceID);
  }
  for (const trace of [...found.feed, ...found.jwks]) add(trace.traceID);
  return [...ids].sort();
}

// This retains full raw sources, warnings and errors. It does not replace the
// owning authority/HTTP/cleanup inspectors. Cancellation is checked separately.
export async function collectOutageTraceArchive(
  base,
  evidence,
  secrets,
  {
    signal,
    directory,
    wait = delay,
    search = searchJaegerTraces,
    collect = collectResolveTraceEvidence,
  },
) {
  await wait(12000, undefined, { signal });
  const now = Date.now(),
    found = { messages: [], feed: [], jwks: [], refresh: [] },
    errors = [],
    ids = new Set();
  const retainID = (id) => {
    try {
      assert.match(id ?? "", /^[a-f0-9]{32}$/u);
      ids.add(id);
    } catch (error) {
      errors.push(error);
    }
  };
  // Inventory/search failures must not suppress independently known requests.
  for (const row of evidence.http) retainID(row.trace_id);
  if (evidence.stream) retainID(evidence.stream.trace_id);
  for (const wire of [evidence.prep_wire, evidence.wire])
    if (wire?.upgrade) retainID(wire.upgrade.trace_id);
  for (const observation of evidence.model_observations)
    for (const request of observation.state.requests)
      retainID(request.trace_id);
  const lookback = `${Math.ceil(now - evidence.observed_at_ms + 5000)}ms`;
  try {
    for (const [name, service, tags, operation] of [
      ["messages", "edge-gateway", { "rpc.service": "acp" }],
      [
        "feed",
        "identity-service",
        { "rpc.method": "list_session_revocations", "span.kind": "server" },
      ],
      [
        "jwks",
        "identity-service",
        {
          "http.route": "/rpc/identity/jwks",
          "http.request.method": "GET",
          "span.kind": "server",
        },
      ],
      ["refresh", "edge-gateway", {}, "gateway.identity.resolve.refresh"],
    ]) {
      const query = new URLSearchParams({
        service,
        lookback,
        limit: "500",
        tags: JSON.stringify(tags),
        ...(operation ? { operation } : {}),
      });
      try {
        signal.throwIfAborted();
        found[name] = await search(base, query, {
          now,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
        assert(found[name].length < 500, "outage Trace search saturated");
      } catch (error) {
        errors.push(error);
        if (signal.aborted) break;
      }
    }
  } finally {
    const raw = JSON.stringify({ now, lookback, found });
    writeEvidenceFile(directory, "outage-trace-search.private.json", raw);
    try {
      assertSecretFree(raw, secrets);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    for (const id of outageTraceSelection(evidence, found)) retainID(id);
  } catch (error) {
    errors.push(error);
  }
  for (const trace of [...found.feed, ...found.jwks]) retainID(trace.traceID);
  if (!found.feed.length)
    errors.push(new Error("actual session feed raw traces missing"));
  if (!found.jwks.length)
    errors.push(new Error("actual JWKS raw traces missing"));
  let chat;
  if (evidence.business_window || evidence.model_cancelled)
    try {
      chat = outageChatExpectation(evidence);
    } catch (error) {
      errors.push(error);
    }
  const reports = [];
  for (const traceID of [...ids].sort()) {
    if (signal.aborted) break;
    try {
      reports.push(
        ...(await collect(
          base,
          [chat?.traceID === traceID ? chat : { traceID }],
          secrets,
          {
            signal,
            directory: join(directory, "outage-traces"),
            inspect(trace, expected, secrets, sources) {
              traceTopology(trace);
              if (chat?.traceID === trace.traceID)
                return {
                  ...inspectWorkspaceChatTrace(
                    trace,
                    expected,
                    secrets,
                    sources,
                  ),
                  owning_gate: "workspace-outage-cancellation",
                };
              return {
                trace_id: trace.traceID,
                raw_span_count: trace.spans.length,
                owning_gate: "pending",
              };
            },
          },
        )),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (signal.aborted && !errors.includes(signal.reason))
    errors.push(signal.reason);
  const result = {
    status: errors.length
      ? "archive_failed"
      : "raw_closures_archived_owning_admission_pending",
    reports,
    owning_gates: {
      cancellation: reports.some(
        (row) => row.trace_id === chat?.traceID && row.settled_read === true,
      )
        ? { status: "passed", trace_id: chat.traceID }
        : { status: "pending" },
    },
    strict_trace:
      errors.length || reports.some((row) => row.strict_trace === "failed")
        ? "failed"
        : "passed",
    archived_trace_ids: [
      ...new Set(
        reports.flatMap((row) => [row.trace_id, ...row.source_trace_ids]),
      ),
    ].sort(),
    failures: errors.map((error) => error.stack ?? String(error)),
  };
  writeEvidenceFile(
    directory,
    "outage-trace-archive.json",
    JSON.stringify(result, null, 2),
  );
  if (errors.length)
    throw new AggregateError(errors, "outage Trace archive failed");
  return result;
}
