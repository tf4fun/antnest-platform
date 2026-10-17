import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import {
  inspectACPClock,
  inspectACPClockReceipt,
  probeACPClock,
} from "./resolve-cache-clock.mjs";

const service = "agent-acp-service";
const quantizationUS = 1000;
const finite = (value) =>
  assert(Number.isFinite(value), "outage ACP clock time missing");
const queryFor = (lookback) => ({
  service,
  operation: "HTTP GET /status",
  lookback,
  limit: "500",
  tags: JSON.stringify({
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/status",
    "antnest.listener": "control",
  }),
});
const snapshot = (traces) =>
  traces
    .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
    .map((trace) => ({
      ...trace,
      spans: trace.spans.toSorted((a, b) => a.spanID.localeCompare(b.spanID)),
    }));

function identity(trace, span) {
  const process = trace.processes[span.processID],
    fields = process.tags ?? [];
  const tags = Object.fromEntries(fields.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(tags).length,
    fields.length,
    "duplicate health process field",
  );
  assert.equal(process.serviceName, service);
  assert(typeof tags["host.name"] === "string" && tags["host.name"].length > 0);
  assert(Number.isSafeInteger(tags["process.pid"]) && tags["process.pid"] > 0);
  assert(
    typeof tags["service.instance.id"] === "string" &&
      tags["service.instance.id"].length > 0,
  );
  return [
    service,
    tags["host.name"],
    tags["process.pid"],
    tags["service.instance.id"],
  ];
}

function receivers(trace) {
  const tree = traceTopology(trace);
  return trace.spans.filter(
    (s) =>
      tree.service(s) === service &&
      (s.operationName === "HTTP GET /status" ||
        (tag(s, "http.request.method") === "GET" &&
          tag(s, "http.route") === "/status")),
  );
}

function receiver(trace) {
  const matches = receivers(trace);
  assert.equal(matches.length, 1, "health receiver missing or ambiguous");
  const [span] = matches,
    tree = traceTopology(trace);
  assert.equal(span.operationName, "HTTP GET /status");
  assert.equal(
    span.references?.length ?? 0,
    0,
    "health receiver has invented parent or Link",
  );
  assert.equal(trace.spans.filter((s) => !tree.parent(s)).length, 1);
  for (const [key, value] of Object.entries(JSON.parse(queryFor("1ms").tags)))
    assert.equal(tag(span, key), value, "health receiver " + key + " differs");
  finite(span.startTime);
  finite(span.duration);
  assert(span.duration >= 0);
  identity(trace, span);
  return span;
}

function healthy(state, project) {
  assert(state, "ACP lifecycle observation missing");
  assert.match(state.id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(state.project, project);
  assert.equal(state.service, service);
  assert(typeof state.host_name === "string" && state.host_name.length > 0);
  for (const [key, value] of Object.entries({
    running: true,
    restarting: false,
    oom_killed: false,
    exit_code: 0,
    health: "healthy",
  }))
    assert.equal(state[key], value, "ACP probe lifecycle " + key + " differs");
  finite(Date.parse(state.started_at));
  finite(Date.parse(state.finished_at));
  finite(state.at);
  assert(Number.isSafeInteger(state.observed_at_ms));
}

function probeReceipt(probe, project) {
  assert(probe, "independent outage ACP clock probe missing");
  const { before, sample, after } = probe;
  healthy(before, project);
  inspectACPClockReceipt(sample);
  healthy(after, project);
  assert.equal(sample.container_id, before.id, "ACP probe container differs");
  for (const key of [
    "id",
    "project",
    "service",
    "host_name",
    "started_at",
    "finished_at",
  ])
    assert.equal(
      after[key],
      before[key],
      "ACP process changed during probe: " + key,
    );
  assert(
    before.at <= sample.started_at && sample.received_at <= after.at,
    "ACP probe not contained in unchanged process observations",
  );
  return sample;
}

// Record immediately so failures retain responses or observations already obtained.
export async function captureOutageACPClock({
  before,
  inspectOwned,
  signal,
  environment = process.env,
  clockProbe = probeACPClock,
  record = () => {},
}) {
  healthy(before, before.project);
  const result = { before };
  record(result);
  result.sample = await clockProbe({
    container: before.id,
    environment,
    signal,
  });
  record(result);
  result.after = await inspectOwned(before.id, service);
  record(result);
  probeReceipt(result, before.project);
  return result;
}

// Fixed now/lookback become exact query bounds in searchJaegerTraces, which
// rejects unread pages. Capture retains all raw candidates and never selects one.
export async function searchOutageACPClock(
  base,
  { search, wait, signal, now, lookback, retainID },
) {
  const query = queryFor(lookback),
    result = { now, query, found: [], rounds: [], errors: [] };
  let previous,
    stable = 0,
    lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      signal.throwIfAborted();
      result.found = await search(base, new URLSearchParams(query), {
        now,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
      result.rounds.push(structuredClone(result.found));
    } catch (error) {
      lastError = error;
      break;
    }
    try {
      assert(Array.isArray(result.found), "health search inventory missing");
      for (const trace of result.found) retainID(trace.traceID);
      assert(
        result.found.length > 0 && result.found.length < 500,
        "health search empty or saturated",
      );
      assert.equal(
        new Set(result.found.map((t) => t.traceID)).size,
        result.found.length,
        "duplicate health Trace",
      );
      for (const trace of result.found) receiver(trace);
      const current = snapshot(result.found);
      stable = isDeepStrictEqual(previous, current) ? stable + 1 : 1;
      previous = structuredClone(current);
      if (stable >= 3) return result;
      lastError = new Error("health raw inventory has not converged");
    } catch (error) {
      lastError = error;
      stable = 0;
      previous = undefined;
    }
    if (attempt + 1 < 20) {
      try {
        await wait(1000, undefined, { signal });
      } catch (error) {
        lastError = error;
        break;
      }
    }
  }
  result.errors.push(lastError ?? new Error("health inventory incomplete"));
  return result;
}

function inventory(collection) {
  const { clockSearches: searches, traces, archivedTraceIDs } = collection;
  assert(searches, "independent health search missing");
  assert.deepEqual(searches.errors, [], "independent health search failed");
  assert.deepEqual(
    searches.query,
    queryFor(searches.query.lookback),
    "health query scope changed",
  );
  finite(searches.now);
  const interval = /^([1-9]\d*)ms$/u.exec(searches.query.lookback);
  assert(interval, "health query needs fixed millisecond bounds");
  const from = (searches.now - Number(interval[1])) * 1000,
    to = searches.now * 1000;
  finite(from);
  finite(to);
  assert(
    Array.isArray(searches.rounds) && searches.rounds.length >= 3,
    "three stable health snapshots required",
  );
  const found = searches.found;
  assert(Array.isArray(found), "health inventory missing");
  for (const round of [...searches.rounds.slice(-3), found]) {
    assert(
      Array.isArray(round) && round.length > 0 && round.length < 500,
      "health search empty or saturated",
    );
    assert.equal(
      new Set(round.map((t) => t.traceID)).size,
      round.length,
      "duplicate health search Trace",
    );
    for (const trace of round) receiver(trace);
    assert.deepEqual(
      snapshot(round),
      snapshot(found),
      "health raw snapshots did not converge",
    );
  }
  const actual = [];
  for (const [id, trace] of traces) {
    const matches = receivers(trace).filter(
      (s) =>
        s.startTime >= from &&
        s.startTime <= to &&
        s.operationName === "HTTP GET /status" &&
        Object.entries(JSON.parse(queryFor("1ms").tags)).every(
          ([key, value]) => tag(s, key) === value,
        ),
    );
    if (!matches.length) continue;
    receiver(trace);
    assert.equal(id, trace.traceID, "health archive key differs");
    assert(archivedTraceIDs.has(id), "health source not archived");
    actual.push(trace);
  }
  assert.deepEqual(
    snapshot(found),
    snapshot(actual),
    "independent health inventory differs from full raw archive",
  );
  return { found, from, to };
}

// coarse comes from verified complete HTTP origins, initialization ancestry and
// generation. Health narrows these existing bounds; it never replaces them.
export function inspectOutageACPClock(evidence, collection, coarse) {
  const sample = probeReceipt(evidence.acp_clock_probe, evidence.project);
  const restarts = evidence.consumer_restarts.filter(
    (r) => r.service === service,
  );
  assert.equal(restarts.length, 1, "old ACP restart missing or ambiguous");
  const [restart] = restarts;
  assert.deepEqual(
    evidence.acp_clock_probe.before,
    restart.before,
    "probe belongs to another ACP lifecycle",
  );
  finite(restart.started_at);
  assert(
    evidence.acp_clock_probe.after.at <= restart.started_at,
    "ACP probe crosses actual restart",
  );
  assert(coarse, "verified same-generation coarse clock missing");
  assert.equal(coarse.service, service);
  assert.equal(coarse.generation, 0);
  assert.equal(coarse.node_sdk_quantization_us, quantizationUS);
  assert(Array.isArray(coarse.samples) && coarse.samples.length > 0);
  finite(coarse.offset_min_us);
  finite(coarse.offset_max_us);
  assert(coarse.offset_min_us < coarse.offset_max_us);
  assert.equal(
    coarse.resource[1],
    restart.before.host_name,
    "coarse clock belongs to another container host",
  );
  const { found, from, to } = inventory(collection);
  const possibleStart =
    sample.started_at * 1000 + coarse.offset_min_us - quantizationUS;
  const possibleEnd = sample.received_at * 1000 + coarse.offset_max_us;
  assert(
    from <= possibleStart && possibleEnd <= to,
    "health query does not cover complete possible probe",
  );
  const candidates = found.map((trace) => {
    const span = receiver(trace),
      resource = identity(trace, span);
    const lower = (span.startTime - coarse.offset_max_us) / 1000;
    const upper =
      (span.startTime + quantizationUS - coarse.offset_min_us) / 1000;
    // The SDK's floor-to-millisecond anchor has an exclusive upper bound.
    // Merely touching send/receive cannot identify this request.
    const intersects = lower < sample.received_at && upper > sample.started_at;
    if (intersects)
      assert.deepEqual(
        resource,
        coarse.resource,
        "foreign health process inside probe window",
      );
    return {
      trace_id: trace.traceID,
      span_id: span.spanID,
      resource,
      lower,
      upper,
      reason: intersects ? "probe-candidate" : "outside-probe-window",
    };
  });
  const selected = candidates.filter((r) => r.reason === "probe-candidate");
  assert.equal(
    selected.length,
    1,
    "outage ACP health probe missing or ambiguous",
  );
  selected[0].reason = "unique-probe-candidate";
  const trace = found.find((t) => t.traceID === selected[0].trace_id);
  const measured = inspectACPClock(sample, [trace]);
  const offset_min_us = Math.max(coarse.offset_min_us, measured.offset_min_us);
  const offset_max_us = Math.min(coarse.offset_max_us, measured.offset_max_us);
  assert(
    offset_min_us < offset_max_us,
    "independent ACP clock intervals do not intersect",
  );
  return {
    ...measured,
    offset_min_us,
    offset_max_us,
    candidates,
    started_at: sample.started_at,
    received_at: sample.received_at,
    container_started_at: restart.before.started_at,
    query_start_us: from,
    query_end_us: to,
  };
}
