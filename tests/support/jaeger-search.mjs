import assert from "node:assert/strict";

function searchQuery(parameters, now) {
  const entries = [...parameters];
  const allowed = new Set([
    "service",
    "operation",
    "tags",
    "lookback",
    "limit",
  ]);
  assert(
    entries.every(([key]) => allowed.has(key)),
    "unsupported Jaeger search field",
  );
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
  const value = Object.fromEntries(entries);
  assert(value.service?.trim(), "Jaeger search service required");
  const interval = /^(\d+)(ms|s|m|h|d)$/u.exec(value.lookback ?? "1h");
  assert(interval, "invalid Jaeger search lookback");
  const lookback =
    Number(interval[1]) *
    { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[interval[2]];
  const searchDepth = Number(value.limit ?? 100);
  assert(
    Number.isSafeInteger(searchDepth) &&
      searchDepth > 0 &&
      searchDepth <= 10000,
  );
  assert(Number.isFinite(now) && Number.isFinite(lookback) && lookback > 0);
  const attributes = JSON.parse(value.tags ?? "{}");
  assert(
    attributes && typeof attributes === "object" && !Array.isArray(attributes),
  );
  for (const field of Object.values(attributes))
    assert(
      ["string", "number", "boolean"].includes(typeof field),
      "invalid Jaeger attribute filter",
    );
  return {
    serviceName: value.service,
    ...(value.operation ? { operationName: value.operation } : {}),
    attributes: Object.fromEntries(
      Object.entries(attributes).map(([key, field]) => [key, String(field)]),
    ),
    startTimeMin: new Date(now - lookback).toISOString(),
    startTimeMax: new Date(now).toISOString(),
    searchDepth,
  };
}

// Jaeger 2.21 removed the old /api/traces search endpoint. Search through v3,
// then read the retained detail endpoint to preserve Jaeger warnings and the
// exact raw trace shape used by the topology/privacy acceptance inspectors.
export async function searchJaegerTraces(
  base,
  parameters,
  {
    signal = AbortSignal.timeout(10000),
    fetchImpl = fetch,
    now = Date.now(),
  } = {},
) {
  signal.throwIfAborted();
  const query = searchQuery(parameters, now);
  const search = new URL("/api/v3/trace-summaries", base);
  for (const [key, value] of Object.entries(query))
    search.searchParams.set(
      `query.${key}`,
      key === "attributes" ? JSON.stringify(value) : String(value),
    );
  const response = await fetchImpl(search, {
    method: "GET",
    signal,
  });
  assert(response.ok, `Jaeger v3 trace search failed: HTTP ${response.status}`);
  // The released HTTP gateway returns FindTraceSummariesResponse directly;
  // the gRPC stream wrapper and POST binding in the IDL are not HTTP routes.
  const result = await response.json();
  assert(
    result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      Object.keys(result).every((key) =>
        ["summaries", "nextPageToken"].includes(key),
      ),
    "invalid Jaeger v3 search response",
  );
  assert(!result.nextPageToken, "unread Jaeger search page");
  const summaries = result.summaries ?? [];
  assert(Array.isArray(summaries), "invalid Jaeger trace summaries");
  const ids = [];
  for (const summary of summaries) {
    assert(
      /^[a-f0-9]{32}$/u.test(summary.traceId),
      "invalid Jaeger trace summary ID",
    );
    assert(!ids.includes(summary.traceId), "duplicate Jaeger trace summary");
    ids.push(summary.traceId);
  }
  const data = [];
  for (const id of ids) {
    signal.throwIfAborted();
    const detail = await fetchImpl(new URL(`/api/traces/${id}`, base), {
      signal,
    });
    assert(detail.ok, "Jaeger trace detail query failed");
    const body = await detail.json();
    assert(
      !body.errors?.length &&
        Array.isArray(body.data) &&
        body.data.length === 1,
      "Jaeger trace detail missing or failed",
    );
    assert.equal(body.data[0].traceID, id, "Jaeger trace detail ID mismatch");
    data.push(body.data[0]);
  }
  return data;
}
