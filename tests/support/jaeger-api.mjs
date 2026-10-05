import assert from "node:assert/strict";

// Jaeger 2.21 removed the legacy service/search endpoints. API v3 returns OTLP resource
// spans in a result wrapper; do not interpret the removed v1 data array.
// https://github.com/jaegertracing/jaeger/releases/tag/v2.21.0
export async function queryJaeger(
  base,
  path,
  { signal, request = fetch } = {},
) {
  const response = await request(`${base.replace(/\/$/u, "")}/api/v3/${path}`, {
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    assert(!response.ok, "Jaeger returned invalid query JSON");
  }
  return { status: response.status, body };
}

export function jaegerTraceSpans(body, traceID) {
  assert(
    Array.isArray(body?.result?.resourceSpans),
    "missing Jaeger resource spans",
  );
  const spans = body.result.resourceSpans.flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
  );
  assert(spans.length > 0, "missing Jaeger spans");
  assert(
    spans.every((span) => span.traceId === traceID),
    "Jaeger trace identity differs",
  );
  return spans;
}
