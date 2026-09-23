import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { traceTree } from "./trace-tree.mjs";

export async function collectTrace(
  base,
  id,
  inspect,
  signal,
  { request = fetch, wait = delay } = {},
) {
  signal?.throwIfAborted();
  await wait(6000, undefined, { signal });
  signal?.throwIfAborted();
  let response;
  let text;
  try {
    response = await request(`${base.replace(/\/$/u, "")}/api/traces/${id}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    text = await response.text();
  } catch {
    signal?.throwIfAborted();
    throw new Error("Jaeger trace request failed");
  }
  assert.equal(response.status, 200, "Jaeger trace request failed");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Jaeger returned invalid JSON");
  }
  assert.equal(
    body.errors?.length ?? 0,
    0,
    "Jaeger query errors require review",
  );
  assert.equal(body.data?.length, 1, "missing/duplicate Jaeger trace");
  const trace = body.data[0];
  assert.equal(trace.traceID, id, "Jaeger returned wrong trace");
  traceTree(trace);
  return inspect(trace);
}

export async function verifyTraces(base, requests, secrets, inspect, signal) {
  assert(requests.length > 0, "model requests missing");
  const result = [];
  for (const id of new Set(requests.map((request) => request.trace_id)))
    result.push(
      await collectTrace(
        base,
        id,
        (trace) =>
          inspect(
            trace,
            requests.filter((request) => request.trace_id === id),
            secrets,
          ),
        signal,
      ),
    );
  return result;
}
