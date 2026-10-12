import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectWorkspaceChatTrace } from "../workspace-closeout/chat-trace.mjs";
import { outagePhase } from "./resolve-cache-outage.mjs";
import { inspectOutageAuthority } from "./resolve-cache-outage-authority.mjs";
import { inspectOutageRejections } from "./resolve-cache-outage-rejection.mjs";
import { inspectRecoveryRunTraces } from "./resolve-cache-recovery-trace.mjs";
import { inspectRecoveryAuthority } from "./resolve-cache-recovery-authority.mjs";
import { inspectRecoveryHTTP as inspectRecoveryHTTPTraces } from "./resolve-cache-recovery-http.mjs";
import { inspectOutageFeed } from "./resolve-cache-outage-feed.mjs";

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
  for (const stream of [
    evidence.stream,
    ...(evidence.recovery?.cases ?? []).map((item) => item.stream),
  ])
    if (stream) add(stream.trace_id);
  for (const wire of [
    evidence.prep_wire,
    evidence.wire,
    ...(evidence.recovery?.cases ?? []).map((item) => item.wire),
  ]) {
    if (!wire?.upgrade) continue;
    add(wire.upgrade.trace_id);
    assert(
      !connections.has(wire.upgrade.trace_id),
      "duplicate WSS connection Trace inventory entry",
    );
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
  for (const trace of [
    ...found.feed,
    ...(found.feedAttempts ?? []),
    ...found.jwks,
  ])
    add(trace.traceID);
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
    inspectAuthority = inspectOutageAuthority,
    inspectRejections = inspectOutageRejections,
    inspectRecovery = inspectRecoveryRunTraces,
    inspectRecoveryBudgets = inspectRecoveryAuthority,
    inspectRecoveryHTTP = inspectRecoveryHTTPTraces,
    inspectFeed = inspectOutageFeed,
  },
) {
  await wait(12000, undefined, { signal });
  const now = Date.now(),
    found = { messages: [], feed: [], feedAttempts: [], jwks: [], refresh: [] },
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
  for (const stream of [
    evidence.stream,
    ...(evidence.recovery?.cases ?? []).map((item) => item.stream),
  ])
    if (stream) retainID(stream.trace_id);
  for (const wire of [
    evidence.prep_wire,
    evidence.wire,
    ...(evidence.recovery?.cases ?? []).map((item) => item.wire),
  ])
    if (wire?.upgrade) retainID(wire.upgrade.trace_id);
  for (const observation of evidence.model_observations)
    for (const request of observation.state.requests)
      retainID(request.trace_id);
  const lookback = `${Math.ceil(now - evidence.observed_at_ms + 5000)}ms`;
  let attemptInventoryComplete = false;
  const attemptSearches = [];
  try {
    for (const [name, service, tags, operation] of [
      ["messages", "edge-gateway", { "rpc.service": "acp" }],
      [
        "feed",
        "identity-service",
        { "rpc.method": "list_session_revocations", "span.kind": "server" },
      ],
      [
        "feedAttempts",
        "edge-gateway",
        {
          "span.kind": "client",
          "http.request.method": "POST",
          "server.address": "identity-service",
        },
        "HTTP POST identity-service",
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
        const read = () =>
          search(base, query, {
            now,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          });
        if (name === "feedAttempts") {
          // SERVER and CLIENT search indexes can become visible separately.
          // Keep the fixed window and every round, including missing attempts.
          let previous,
            stable = 0;
          for (let attempt = 0; attempt < 20; attempt++) {
            found[name] = await read();
            attemptSearches.push(found[name]);
            for (const trace of found[name]) retainID(trace.traceID);
            assert(found[name].length < 500, "outage Trace search saturated");
            const ids = found[name].map((t) => t.traceID).sort();
            assert.equal(
              new Set(ids).size,
              ids.length,
              "duplicate Gateway attempt inventory entry",
            );
            const current = JSON.stringify(ids);
            const covered = found.feed.every((t) => ids.includes(t.traceID));
            stable = covered ? (current === previous ? stable + 1 : 1) : 0;
            previous = current;
            if (stable >= 3) {
              attemptInventoryComplete = true;
              break;
            }
            if (attempt + 1 < 20) await wait(1000, undefined, { signal });
          }
          assert(
            attemptInventoryComplete,
            "Gateway attempt inventory did not converge",
          );
        } else {
          found[name] = await read();
          assert(found[name].length < 500, "outage Trace search saturated");
        }
      } catch (error) {
        errors.push(error);
        if (signal.aborted) break;
      }
    }
  } finally {
    const raw = JSON.stringify({
      now,
      lookback,
      found,
      feed_attempt_searches: attemptSearches,
    });
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
  for (const trace of [...found.feed, ...found.feedAttempts, ...found.jwks])
    retainID(trace.traceID);
  if (!found.feed.length)
    errors.push(new Error("actual session feed raw traces missing"));
  if (!found.jwks.length)
    errors.push(new Error("actual JWKS raw traces missing"));
  if (!found.feedAttempts.length)
    errors.push(new Error("Gateway Identity attempt inventory missing"));
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
  const archivedTraceIDs = new Set(
    reports.flatMap((row) => [row.trace_id, ...row.source_trace_ids]),
  );
  let authority = { status: "pending" },
    rejections = { status: "pending" },
    recovery = { status: "pending" },
    recoveryAuthority = { status: "pending" },
    recoveryHTTP = { status: "pending" },
    feed = { status: "pending" },
    collection;
  if (evidence.business_window) {
    try {
      assert(attemptInventoryComplete, "Gateway attempt inventory incomplete");
      assert(
        found.feedAttempts.length > 0,
        "Gateway Identity attempt inventory missing",
      );
      for (const trace of found.feedAttempts)
        assert(
          archivedTraceIDs.has(trace.traceID),
          "Gateway attempt was not archived",
        );
      const traces = new Map(
        [...archivedTraceIDs].map((id) => [
          id,
          JSON.parse(
            readFileSync(
              join(directory, "outage-traces", `${id}.json`),
              "utf8",
            ),
          ),
        ]),
      );
      collection = {
        traces,
        archivedTraceIDs,
        feedAttemptTraceIDs: new Set(found.feedAttempts.map((t) => t.traceID)),
        feedSearch: {
          now,
          lookback,
          found: { feed: found.feed },
          feed_attempt_searches: attemptSearches,
        },
      };
      authority = await inspectAuthority(evidence, collection, secrets);
    } catch (error) {
      errors.push(error);
    }
  }
  if (evidence.business_window && evidence.rejections) {
    try {
      assert(collection, "HTTP rejection raw archive missing");
      rejections = await inspectRejections(evidence, collection, secrets);
    } catch (error) {
      errors.push(error);
    }
  }
  if (evidence.business_window) {
    try {
      assert(collection, "feed raw archive missing");
      const result = await inspectFeed(evidence, collection, secrets);
      assert.equal(
        result?.status,
        "passed",
        "feed owning inspector did not pass",
      );
      assert(
        Array.isArray(result.owned_error_spans),
        "feed error claims missing",
      );
      feed = result;
    } catch (error) {
      errors.push(error);
    }
  }
  if (evidence.recovery_window) {
    try {
      assert(collection, "recovery Run raw archive missing");
      recovery = await inspectRecovery(evidence, collection, secrets);
    } catch (error) {
      errors.push(error);
    }
    try {
      assert(collection, "recovery authority raw archive missing");
      recoveryAuthority = await inspectRecoveryBudgets(
        evidence,
        collection,
        secrets,
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      assert(collection, "recovery HTTP raw archive missing");
      recoveryHTTP = await inspectRecoveryHTTP(evidence, collection, secrets);
    } catch (error) {
      errors.push(error);
    }
  }
  const result = {
    status: errors.length
      ? "archive_failed"
      : "raw_closures_archived_owning_admission_pending",
    reports,
    owning_gates: {
      authority,
      http_rejections: rejections,
      recovery_runs: recovery,
      recovery_authority: recoveryAuthority,
      recovery_http: recoveryHTTP,
      feed,
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
    archived_trace_ids: [...archivedTraceIDs].sort(),
    feed_attempt_trace_ids: found.feedAttempts.map((t) => t.traceID).sort(),
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
