import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { inspectHTTPTrace } from "./evidence.mjs";

async function readTrace(url, traceID, request) {
  const response = await request(url, { signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return undefined;
  assert(response.ok, `Jaeger query failed (${response.status})`);
  const body = await response.json();
  assert.equal(
    body.errors?.length ?? 0,
    0,
    "Jaeger query errors require review",
  );
  return body.data?.find((trace) => trace.traceID === traceID);
}

export async function queryHTTPTrace(
  base,
  traceID,
  config,
  { request = fetch, wait = setTimeout } = {},
) {
  await wait(6000);
  const url = `${base.replace(/\/$/u, "")}/api/traces/${traceID}`;
  const trace = await readTrace(url, traceID, request);
  return inspectHTTPTrace(trace, config);
}
