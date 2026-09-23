import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { inspectLifecycle } from "./evidence.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export async function verifyLifecycleTrace(base, operation, secrets, signal) {
  assert(
    Array.isArray(secrets) &&
      secrets.length > 0 &&
      secrets.every((s) => typeof s === "string" && s.length > 0),
    "trace secrets are required",
  );
  let last;
  for (let i = 0; i < 40; i++) {
    signal?.throwIfAborted();
    let bodies;
    try {
      const read = async (path) => {
        const response = await fetch(base + path, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        return response.text();
      };
      const admission = await read(`/api/traces/${operation.traceID}`);
      bodies = { admission };
    } catch (error) {
      signal?.throwIfAborted();
      last = error;
    }
    if (bodies) {
      assertSecretFree(bodies.admission, secrets);
      let snapshot;
      try {
        snapshot = {
          admission: JSON.parse(bodies.admission).data?.[0],
        };
      } catch {
        throw new Error("Jaeger returned invalid JSON");
      }
      assertSecretFree(JSON.stringify(snapshot), secrets);
      if (snapshot.admission)
        assert.equal(
          snapshot.admission.traceID,
          operation.traceID,
          "Jaeger returned a different admission trace",
        );
      try {
        return inspectLifecycle({ ...operation, ...snapshot });
      } catch (error) {
        last = error;
      }
    }
    await delay(1000, undefined, { signal });
  }
  throw last;
}
