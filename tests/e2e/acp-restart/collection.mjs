import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Best-effort crash evidence only. Completed requests use the strict collector.
export async function collectInterruptedTrace(
  base,
  id,
  { fetcher = fetch, wait = () => delay(1000), attempts = 12 } = {},
) {
  let latest,
    previous,
    stable = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetcher(`${base}/api/traces/${id}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) {
      // The killed process may never have exported any spans for this ID.
      await response.arrayBuffer();
      stable = 0;
      previous = undefined;
      if (attempt + 1 < attempts) await wait();
      continue;
    }
    assert(response.ok, "Jaeger diagnostic request failed");
    const { data } = await response.json();
    assert(
      Array.isArray(data) && data.length <= 1,
      "invalid diagnostic trace response",
    );
    if (data.length) {
      latest = data[0];
      assert.equal(latest.traceID, id, "foreign diagnostic trace");
      const current = JSON.stringify(latest.spans.map((s) => s.spanID).sort());
      stable = previous === current ? stable + 1 : 1;
      previous = current;
      if (stable >= 3) return latest;
    }
    if (attempt + 1 < attempts) await wait();
  }
  return latest;
}
