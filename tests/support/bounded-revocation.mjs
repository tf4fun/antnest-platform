import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function observeBoundedRevocation({
  committedMS,
  ttlMS,
  request,
  now = () => performance.now(),
  wait = delay,
  record = () => {},
  validate = () => {},
  signal,
}) {
  assert(
    Number.isFinite(committedMS) &&
      Number.isFinite(ttlMS) &&
      ttlMS >= 0 &&
      ttlMS <= 30000,
  );
  const observations = [],
    identities = new Set();
  for (;;) {
    signal?.throwIfAborted();
    const startedMS = now();
    assert(
      Number.isFinite(startedMS) &&
        startedMS >= (observations.at(-1)?.completedMS ?? committedMS),
    );
    const response = await request();
    const item = {
      startedMS,
      completedMS: now(),
      status: response.status,
      traceID: response.traceID,
    };
    observations.push(item);
    record(item, response);
    signal?.throwIfAborted();
    assert(
      typeof item.traceID === "string" && /^[a-f0-9]{32}$/u.test(item.traceID),
      "invalid revocation observation Trace",
    );
    assert(
      !identities.has(item.traceID),
      "duplicate revocation observation Trace",
    );
    identities.add(item.traceID);
    assert(Number.isFinite(item.completedMS) && item.completedMS >= startedMS);
    assert([200, 401].includes(item.status), "unexpected revocation response");
    await validate(response, item);
    signal?.throwIfAborted();
    if (item.status === 401) return observations;
    assert(
      startedMS < committedMS + ttlMS,
      "revoked Principal admitted after snapshot TTL",
    );
    await wait(
      Math.min(100, Math.max(0, committedMS + ttlMS - now())),
      undefined,
      { signal },
    );
  }
}
