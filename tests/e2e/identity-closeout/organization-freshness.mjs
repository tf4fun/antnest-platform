import assert from "node:assert/strict";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  tag,
  traceTopology,
  owningServerTopology,
} from "../observability/trace-tree.mjs";

export const displaySurfaces = {
  session: { path: "/api/session", route: "/api/session", profile: "session" },
  bootstrap: {
    path: "/api/app/workspace/v1/bootstrap",
    route: "/api/app/workspace/v1/{path...}",
    profile: "workspace",
    nodeRoute: "/api/app/workspace/v1/*",
  },
  ssr: {
    path: "/workspace/",
    route: "/workspace/{path...}",
    profile: "workspace",
    nodeRoute: "/workspace/",
  },
};
const one = (items, message) => {
  assert.equal(items.length, 1, message);
  return items[0];
};
// Runtime records (success, "", OK) for completed MCP operations, including
// Initialize catalog reads in a refresh trigger's raw closure. Preserve that
// empty placeholder; no other error-type shape or failed signal is exempt.
const successfulRuntimeErrorPlaceholder = (span, trace) =>
  trace.processes[span.processID]?.serviceName === "antnest-runtime" &&
  span.operationName === "runtime.mcp.operation" &&
  tag(span, "error.type") === "" &&
  tag(span, "otel.status_code") === "OK" &&
  tag(span, "mcp.operation.outcome") === "success" &&
  tag(span, "antnest.operation.outcome") === "success";
const failed = (span, trace) =>
  hasError(span) ||
  tag(span, "otel.status_code") === "ERROR" ||
  tag(span, "otel.status_code") === 2 ||
  (tag(span, "error.type") !== undefined &&
    !successfulRuntimeErrorPlaceholder(span, trace)) ||
  tag(span, "http.response.status_code") >= 400;
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished display evidence span",
  );
  return span.startTime + span.duration;
};
function successfulSources(trace, secrets, collection) {
  const sources = resolveTraceSources(trace, secrets, collection);
  assert(
    !sources.some((source) =>
      source.spans.some((span) => failed(span, source)),
    ),
    "display evidence contains failed request or SQL",
  );
  return resolveTraceDiagnostics(trace, sources);
}

export function inspectOrganizationRead(
  trace,
  expected,
  secrets,
  collection = {},
) {
  assert.equal(trace.traceID, expected.traceID);
  const surface = displaySurfaces[expected.surface];
  assert(surface, "unknown Organization display surface");
  const diagnostics = successfulSources(trace, secrets, collection);
  const tree = traceTopology(trace);
  const root = one(
    trace.spans.filter((s) => !tree.parent(s)),
    "one complete Gateway display request required",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), surface.route);
  assert.equal(tag(root, "http.request.method"), "GET");
  assert.equal(tag(root, "http.response.status_code"), 200);
  const decision = one(
    trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
    "one display Resolve decision required",
  );
  let upstream;
  if (surface.nodeRoute) {
    const node = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === "agent-ui" && tag(s, "span.kind") === "server",
      ),
      "actual Node display receiver required",
    );
    assert.equal(tag(node, "http.request.method"), "GET");
    assert.equal(tag(node, "http.route"), surface.nodeRoute);
    assert.equal(tag(node, "http.response.status_code"), 200);
    upstream = tree.parent(node);
    assert(upstream, "Node display forwarding missing");
    assert.equal(tag(upstream, "http.request.method"), "GET");
    assert.equal(tag(upstream, "http.response.status_code"), 200);
  }
  const resolution = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      decisionSpanID: decision.spanID,
      profile: surface.profile,
      ttlMs: expected.ttlMS,
      ...(upstream ? { upstreamSpanID: upstream.spanID } : {}),
    },
    collection,
  );
  return {
    ...resolution,
    ...diagnostics,
    surface: expected.surface,
    root_started_us: root.startTime,
    root_completed_us: end(root),
    ...(resolution.source === "rpc"
      ? {
          rpc_client_started_us: trace.spans.find(
            (s) => s.spanID === resolution.rpc_client_span_id,
          ).startTime,
        }
      : {}),
    decision_started_us: decision.startTime,
    decision_completed_us: end(decision),
    ...(resolution.source === "cache"
      ? {
          snapshot_age_ms: tag(
            decision,
            "antnest.identity.resolve.snapshot_age_ms",
          ),
          proof_age_ms: tag(decision, "antnest.identity.resolve.proof_age_ms"),
          valid_for_ms: tag(decision, "antnest.identity.resolve.valid_for_ms"),
        }
      : {}),
  };
}

export function selectSessionFeedRequests(traces, earliest, latest) {
  assert(
    Number.isFinite(earliest) && Number.isFinite(latest) && earliest <= latest,
  );
  const expected = [];
  for (const trace of traces) {
    const { client } = sessionFeedRPC(trace);
    end(client);
    if (client.startTime >= earliest && client.startTime <= latest)
      expected.push({ traceID: trace.traceID });
  }
  return expected;
}

function sessionFeedRPC(trace) {
  const result = owningServerTopology(trace, {
    service: "identity-service",
    route: "/rpc/identity/list-session-revocations",
    method: "POST",
    rpcMethod: "list_session_revocations",
    clientService: "edge-gateway",
  });
  assert.equal(tag(result.client, "rpc.method"), "list_session_revocations");
  assert.equal(
    traceTopology(trace).parent(result.client),
    undefined,
    "feed must be process-owned work",
  );
  return result;
}

export function inspectEmptySessionFeed(
  trace,
  expected,
  secrets,
  collection = {},
) {
  assert.equal(trace.traceID, expected.traceID);
  const diagnostics = successfulSources(trace, secrets, collection);
  const { client, server, database } = sessionFeedRPC(trace);
  assert.equal(tag(server, "http.response.status_code"), 200);
  assert.equal(tag(client, "http.response.status_code"), 200);
  const sql = one(database, "one actual session feed SELECT required");
  assert.equal(tag(sql, "db.operation.name"), "SELECT");
  assert.equal(
    tag(sql, "db.query.text").replace(/\s+/gu, " ").trim(),
    "SELECT sequence, token_id, user_id, organization_id, reason, occurred_at, traceparent FROM session_revocations WHERE sequence > $1 ORDER BY sequence LIMIT $2",
  );
  assert.equal(
    tag(sql, "pgx.rows_affected"),
    0,
    "session feed page was not empty",
  );
  end(server);
  end(sql);
  return {
    trace_id: trace.traceID,
    client_span_id: client.spanID,
    identity_server_span_id: server.spanID,
    sql_span_id: sql.spanID,
    rows: 0,
    started_us: client.startTime,
    completed_us: end(client),
    ...diagnostics,
  };
}

export function inspectOrganizationRefresh(
  trace,
  expected,
  secrets,
  collection,
) {
  assert.equal(trace.traceID, expected.traceID);
  const diagnostics = successfulSources(trace, secrets, collection);
  const tree = traceTopology(trace);
  const root = one(
    trace.spans.filter((s) => !tree.parent(s)),
    "one process-owned refresh root required",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(root.operationName, "gateway.identity.resolve.refresh");
  assert.equal(tag(root, "span.kind"), "internal");
  assert.equal(tag(root, "antnest.identity.resolve.profile"), expected.profile);
  assert.equal(tag(root, "antnest.identity.resolve.outcome"), "admitted");
  const link = one(
    root.references.filter((r) => r.refType === "FOLLOWS_FROM"),
    "refresh trigger missing",
  );
  assert.equal(link.traceID, expected.triggerTraceID);
  assert.equal(link.spanID, expected.triggerDecisionID);
  const trigger = collection.traces.get(link.traceID);
  assert(
    trigger && collection.archivedTraceIDs.has(trigger.traceID),
    "refresh trigger was not archived",
  );
  const triggerTree = traceTopology(trigger);
  const decision = triggerTree.spans.get(link.spanID);
  assert(
    decision &&
      tag(decision, "antnest.identity.resolve.snapshot_age_ms") >=
        expected.ttlMS / 2,
    "refresh did not follow the half-TTL hit",
  );
  inspectGatewayResolution(
    trigger,
    {
      rootSpanID: triggerTree.parent(decision)?.spanID,
      decisionSpanID: decision.spanID,
      profile: expected.profile,
      ttlMs: expected.ttlMS,
    },
    collection,
  );
  assert.equal(tag(decision, "antnest.identity.resolve.source"), "cache");
  assert(root.startTime >= decision.startTime);
  const { client, server, database } = owningServerTopology(trace, {
    service: "identity-service",
    route: "/rpc/identity/resolve-access-token",
    method: "POST",
    rpcMethod: "resolve_access_token",
    clientService: "edge-gateway",
    status: 200,
  });
  assert.equal(tree.parent(client), root);
  assert.equal(tag(client, "http.response.status_code"), 200);
  assert(client.startTime >= root.startTime && end(client) <= end(root));
  return {
    trace_id: trace.traceID,
    trigger_trace_id: trigger.traceID,
    trigger_decision_id: decision.spanID,
    profile: expected.profile,
    rpc_client_span_id: client.spanID,
    identity_server_span_id: server.spanID,
    identity_sql: database.length,
    ...diagnostics,
  };
}

export function assertDisplayFeedCoverage(resolutions, feeds, ttlMS) {
  const proofs = resolutions
    .filter((r) => r.source === "cache")
    .map((r) => [
      r.decision_started_us - r.proof_age_ms * 1000,
      r.decision_completed_us - r.proof_age_ms * 1000,
    ])
    .sort((a, b) => a[0] - b[0]);
  assert(
    proofs.length >= 3 && proofs.every((r) => r.every(Number.isFinite)),
    "cache proof observations missing",
  );
  const distinct = [];
  for (const proof of proofs)
    if (!distinct.length || proof[0] > distinct.at(-1)[1] + 2)
      distinct.push(proof);
  assert(
    distinct.length >= 3 && distinct.at(-1)[0] - distinct[0][1] >= ttlMS * 500,
    "feed proof did not advance through the display interval",
  );
  const pages = [...feeds].sort((a, b) => a.started_us - b.started_us);
  assert(
    pages.length >= 3 &&
      pages.every(
        (p) =>
          p.rows === 0 &&
          Number.isFinite(p.started_us) &&
          Number.isFinite(p.completed_us) &&
          p.completed_us >= p.started_us,
      ),
    "healthy empty feed pages missing",
  );
  // Poll records its proof just before starting the CLIENT span. This is a
  // coverage boundary, not a claim of a causal Trace link to a cache hit.
  assert(
    pages[0].started_us <= proofs[0][1] + 2000 &&
      pages.at(-1).started_us >= proofs.at(-1)[0] - 2000,
    "empty feed evidence does not cover observed proofs",
  );
  let maxGap = 0;
  for (let i = 1; i < pages.length; i++)
    maxGap = Math.max(maxGap, pages[i].started_us - pages[i - 1].completed_us);
  assert(maxGap <= 2500000, "empty feed polling has an unobserved interval");
  return {
    empty_pages: pages.length,
    advancing_proofs: distinct.length,
    max_observed_poll_gap_ms: maxGap / 1000,
    proof_advance_ms: (distinct.at(-1)[0] - distinct[0][1]) / 1000,
  };
}

export function assertOrganizationTimeline({
  ttlMS,
  renameStartedMS,
  renameCommittedMS,
  reads,
  resolutions,
}) {
  assert(Number.isFinite(ttlMS) && ttlMS > 0 && ttlMS <= 30000);
  assert(
    Number.isFinite(renameStartedMS) &&
      Number.isFinite(renameCommittedMS) &&
      renameStartedMS <= renameCommittedMS,
  );
  const deadline = renameCommittedMS + ttlMS;
  const byTrace = new Map(resolutions.map((r) => [r.trace_id, r]));
  assert.equal(
    byTrace.size,
    resolutions.length,
    "duplicate display resolution evidence",
  );
  assert.equal(
    resolutions.length,
    reads.length,
    "display resolution evidence missing",
  );
  assert.equal(
    new Set(reads.map((r) => r.traceID)).size,
    reads.length,
    "duplicate display request identity",
  );
  for (const read of reads) {
    assert(
      displaySurfaces[read.surface] &&
        ["continuous", "expiry"].includes(read.mode),
    );
    assert(
      ["warm", "before-rename", "after-rename", "expired"].includes(read.phase),
    );
    assert(
      Number.isFinite(read.startedMS) &&
        Number.isFinite(read.completedMS) &&
        read.startedMS <= read.completedMS,
    );
    assert(["original", "renamed"].includes(read.snapshot));
    assert.equal(
      byTrace.get(read.traceID)?.surface,
      read.surface,
      "wrong display resolution evidence",
    );
    if (read.phase === "warm" || read.phase === "before-rename") {
      assert(
        read.completedMS <= renameStartedMS,
        "pre-rename read crossed mutation",
      );
      assert.equal(read.snapshot, "original");
    } else
      assert(
        read.startedMS >= renameCommittedMS,
        "read overlapped rename transaction",
      );
    if (read.startedMS >= deadline)
      assert.equal(
        read.snapshot,
        "renamed",
        "old Organization snapshot survived TTL",
      );
  }
  const surfaces = [];
  for (const surface of Object.keys(displaySurfaces))
    for (const mode of ["continuous", "expiry"]) {
      const group = reads.filter(
        (r) => r.surface === surface && r.mode === mode,
      );
      const warm = one(
        group.filter((r) => r.phase === "warm"),
        "display scope was not independently warmed",
      );
      const warmResolution = byTrace.get(warm.traceID);
      assert.equal(
        warmResolution.source,
        "rpc",
        "fresh display token did not perform Resolve",
      );
      const early = group.filter((r) => r.phase === "before-rename");
      assert(early.length >= 2, "repeated early reads missing");
      for (const read of early) {
        const resolution = byTrace.get(read.traceID);
        assert.equal(
          resolution.source,
          "cache",
          "actual repeated display cache hits missing",
        );
        assert(
          resolution.snapshot_age_ms < ttlMS / 2 &&
            read.completedMS < warm.startedMS + ttlMS / 2,
          "early reads reached background refresh window",
        );
      }
      let originLow = warmResolution.decision_started_us - 2,
        originHigh = warmResolution.rpc_client_started_us + 2;
      assert(
        Number.isFinite(originLow) &&
          Number.isFinite(originHigh) &&
          originLow <= originHigh,
        "warm Resolve timing missing",
      );
      let previous,
        renamed = false;
      for (const read of group) {
        if (previous)
          assert(
            read.startedMS >= previous.completedMS,
            "display scope reads overlap or are unordered",
          );
        previous = read;
        if (renamed)
          assert.equal(
            read.snapshot,
            "renamed",
            "Organization display regressed after update",
          );
        renamed ||= read.snapshot === "renamed";
        const r = byTrace.get(read.traceID);
        if (read.snapshot === "original" && r.source === "cache") {
          // The cache observes time inside the decision. Keep the whole measured
          // interval; Jaeger rounds span timestamps to microseconds.
          originLow = Math.max(
            originLow,
            r.decision_started_us - r.snapshot_age_ms * 1000 - 2,
          );
          originHigh = Math.min(
            originHigh,
            r.decision_completed_us - r.snapshot_age_ms * 1000 + 2,
          );
          assert(
            originLow <= originHigh,
            "cache hit renewed the old display snapshot",
          );
        }
      }
      const expired = one(
        group.filter((r) => r.phase === "expired"),
        "first post-expiry read missing",
      );
      assert(expired.startedMS >= deadline);
      if (mode === "expiry") {
        assert(
          !group.some((r) => r.phase === "after-rename"),
          "quiet expiry scope was accessed early",
        );
        assert.equal(
          byTrace.get(expired.traceID).source,
          "rpc",
          "expired quiet scope did not perform live Resolve",
        );
      } else {
        assert(
          group.some(
            (r) =>
              r.phase === "after-rename" &&
              byTrace.get(r.traceID).source === "cache",
          ),
          "continuous display hits missing",
        );
        assert(
          group.some(
            (r) =>
              r.snapshot === "renamed" &&
              byTrace.get(r.traceID).source === "cache",
          ),
          "refreshed display snapshot was not reused",
        );
      }
      surfaces.push({
        surface,
        mode,
        reads: group.length,
        cache_hits: group.filter(
          (r) => byTrace.get(r.traceID).source === "cache",
        ).length,
        expiry_read_delay_ms: expired.startedMS - deadline,
        expiry_response_latency_ms: expired.completedMS - expired.startedMS,
        expiry_visible_after_commit_ms: expired.completedMS - renameCommittedMS,
      });
    }
  return {
    ttl_ms: ttlMS,
    rename_started_ms: renameStartedMS,
    rename_committed_ms: renameCommittedMS,
    surfaces,
  };
}
