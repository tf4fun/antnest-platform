import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveCompleted } from "./archive.mjs";
test("completed request evidence is archived before another kill, while interrupted work remains uncached", async () => {
  const requests = [
      { label: "new", kind: "request", requestId: "2" },
      { label: "fault", kind: "interruption", requestId: "3" },
      { label: "replay", kind: "request", requestId: "2" },
    ],
    cache = new Map(),
    seen = [];
  const collect = async (r) => {
    seen.push(r.label);
    return { traceID: r.label };
  };
  await archiveCompleted(requests, cache, collect);
  await archiveCompleted(requests, cache, collect);
  assert.deepEqual(seen, ["new", "replay"]);
  assert.equal(cache.has("fault"), false);
  assert.equal(cache.get("replay").trace.traceID, "replay");
  await assert.rejects(
    archiveCompleted(
      [{ ...requests[0], requestId: "foreign" }],
      cache,
      collect,
    ),
  );
});
test("failed export blocks the next fault and cannot cache nonexistent evidence", async () => {
  const cache = new Map();
  await assert.rejects(
    archiveCompleted([{ label: "x", kind: "request" }], cache, async () => {
      throw Error("missing");
    }),
  );
  assert.equal(cache.size, 0);
});
