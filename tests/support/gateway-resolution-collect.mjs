import assert from "node:assert/strict";
import { evidenceDirectory, writeEvidenceFile } from "./storage.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../e2e/observability/trace-tree.mjs";

const prefix = "antnest.identity.resolve.";
const decision = "gateway.identity.resolve";
const refresh = decision + ".refresh";
const value = (span, key) => tag(span, prefix + key);
const idPattern = /^[a-f0-9]{32}$/u;

function references(trace, captureRpcContent) {
  const tree = traceTopology(trace);
  if (captureRpcContent !== true) assertCaptureDisabled(trace);
  return trace.spans.flatMap((span) => {
    if (![decision, refresh].includes(span.operationName)) return [];
    assert(
      tree.service(span) === "edge-gateway",
      "foreign Resolve diagnostic span",
    );
    const links = (span.references ?? []).filter(
      (ref) => ref.refType === "FOLLOWS_FROM",
    );
    if (span.operationName === decision) {
      if (value(span, "source") !== "shared") return [];
      if (value(span, "shared_source_state") === "cancelled-before-client") {
        assert(
          value(span, "outcome") === "unavailable" && links.length === 0,
          "cancelled-before-client must not invent source admission",
        );
        return [];
      }
      assert.equal(
        value(span, "shared_source_state"),
        "actual-client",
        "unknown shared source state",
      );
    }
    assert.equal(links.length, 1, "one exact Resolve source link required");
    const link = links[0];
    assert(
      idPattern.test(link.traceID ?? "") &&
        typeof link.spanID === "string" &&
        link.spanID.length > 0,
      "invalid Resolve source link identity",
    );
    return [
      {
        ...link,
        fromTraceID: trace.traceID,
        fromSpanID: span.spanID,
        kind:
          span.operationName === refresh ? "refresh-trigger" : "shared-client",
        profile: value(span, "profile"),
      },
    ];
  });
}

function verifyTarget(trace, reference) {
  const tree = traceTopology(trace),
    target = tree.spans.get(reference.spanID);
  assert(target, "exact linked Resolve span missing");
  assert(
    tree.service(target) === "edge-gateway",
    "linked Resolve source is not Gateway",
  );
  assert(
    Number.isFinite(target.startTime) &&
      Number.isFinite(target.duration) &&
      target.duration >= 0,
    "linked Resolve source is unfinished",
  );
  assert(
    tree.parent(target),
    "linked Resolve source lacks complete request/work ancestry",
  );
  if (reference.kind === "shared-client") {
    assert(
      tag(target, "span.kind") === "client" &&
        tag(target, "http.request.method") === "POST",
      "shared source must link the actual RPC CLIENT",
    );
  } else {
    assert(
      target.operationName === decision &&
        tag(target, "span.kind") === "internal" &&
        value(target, "source") === "cache" &&
        value(target, "outcome") === "admitted" &&
        value(target, "profile") === reference.profile,
      "refresh must link its actual cache-hit decision",
    );
  }
}

// Fetch once per trace in this snapshot. Existing callers retain their own
// initial export wait or whole-closure convergence policy; this collector never
// retries a partial response or pretends it is sufficient evidence.
// The returned collection is not admission evidence: the owning adapter must
// inspect each Resolve decision against it, plus its existing business, SQL,
// payload, secret, warning and error gates.
export async function collectResolutionSources(
  base,
  initial,
  {
    request = fetch,
    signal,
    directory,
    maxTraces = 128,
    captureRpcContent = false,
  } = {},
) {
  signal?.throwIfAborted();
  directory = evidenceDirectory(directory);
  assert(
    Array.isArray(initial) && initial.length > 0,
    "initial request traces missing",
  );
  assert(
    Number.isSafeInteger(maxTraces) && maxTraces > 0,
    "invalid source collection limit",
  );
  const traces = new Map(),
    archivedTraceIDs = new Set(),
    queue = [],
    links = [];
  function retain(trace) {
    assert(
      idPattern.test(trace?.traceID ?? ""),
      "invalid collected trace identity",
    );
    const prior = traces.get(trace.traceID);
    if (prior) {
      assert(
        JSON.stringify(prior) === JSON.stringify(trace),
        "conflicting raw source trace snapshots",
      );
      return;
    }
    assert(
      traces.size < maxTraces,
      "Resolve source trace collection limit exceeded",
    );
    if (directory) {
      // Preserve the raw snapshot even when its topology is incomplete. The
      // owning collector can later archive a fully converged replacement.
      writeEvidenceFile(
        directory,
        `${trace.traceID}.json`,
        JSON.stringify(trace),
      );
      archivedTraceIDs.add(trace.traceID);
    }
    const edges = references(trace, captureRpcContent);
    if (edges.length)
      assert(directory, "Resolve source evidence requires a durable archive");
    traces.set(trace.traceID, trace);
    queue.push({ trace, edges });
  }
  for (const trace of initial) retain(trace);
  for (let index = 0; index < queue.length; index++) {
    for (const reference of queue[index].edges) {
      signal?.throwIfAborted();
      if (!traces.has(reference.traceID)) {
        assert(
          traces.size < maxTraces,
          "Resolve source trace collection limit exceeded",
        );
        let response, text;
        try {
          response = await request(
            `${base.replace(/\/$/u, "")}/api/traces/${reference.traceID}`,
            {
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
                : AbortSignal.timeout(10000),
            },
          );
          text = await response.text();
        } catch {
          signal?.throwIfAborted();
          throw new Error("Jaeger Resolve source request failed");
        }
        signal?.throwIfAborted();
        assert(response.status === 200, "Jaeger Resolve source request failed");
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error("Jaeger returned invalid Resolve source JSON");
        }
        assert(
          body.errors == null ||
            (Array.isArray(body.errors) && body.errors.length === 0),
          "Jaeger Resolve source query errors require review",
        );
        assert(
          Array.isArray(body.data) && body.data.length === 1,
          "missing/duplicate Resolve source trace",
        );
        assert(
          body.data[0]?.traceID === reference.traceID,
          "Jaeger returned wrong Resolve source trace",
        );
        retain(body.data[0]);
      }
      // Deduplication is by fetch, never by link: a second reference to the same
      // trace still must identify its own real target span.
      verifyTarget(traces.get(reference.traceID), reference);
      links.push(reference);
    }
  }
  return { traces, archivedTraceIDs, links };
}
