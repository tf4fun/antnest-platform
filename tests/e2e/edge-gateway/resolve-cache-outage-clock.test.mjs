import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectOutageACPClock,
  searchOutageACPClock,
  captureOutageACPClock,
} from "./resolve-cache-outage-clock.mjs";
import {
  outageClockFixture,
  syncOutageClockSearch,
} from "./resolve-cache-outage-clock-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const check = (f) => inspectOutageACPClock(f.evidence, f, f.coarse);
test("outage uses its own unique health probe among earlier complete raw candidates", () => {
  const f = outageClockFixture(),
    original = structuredClone({ ...f, health: null });
  const result = check(f);
  assert.equal(result.source_trace_id, f.clockSearches.found[1].traceID);
  assert.equal(result.offset_min_us, f.epoch - 3000);
  assert.equal(result.offset_max_us, f.epoch + 4000);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].reason, "outside-probe-window");
  assert.equal(result.candidates[1].reason, "unique-probe-candidate");
  assert.deepEqual(
    { ...f, health: null },
    original,
    "raw evidence must remain unchanged",
  );
});

for (const [name, change] of [
  [
    "missing independent receipt",
    (f) => {
      delete f.evidence.acp_clock_probe;
    },
  ],
  [
    "incomplete response",
    (f) => {
      f.evidence.acp_clock_probe.sample.body_complete = false;
    },
  ],
  [
    "failed response",
    (f) => {
      f.evidence.acp_clock_probe.sample.status = 503;
    },
  ],
  [
    "another container",
    (f) => {
      f.evidence.acp_clock_probe.sample.container_id = "d".repeat(64);
    },
  ],
  [
    "process restarted during probe",
    (f) => {
      f.evidence.acp_clock_probe.after.started_at = new Date(
        f.epoch / 1000,
      ).toISOString();
    },
  ],
  [
    "probe after stop",
    (f) => {
      f.evidence.consumer_restarts[0].started_at = 1705;
    },
  ],
  [
    "probe before inspected baseline",
    (f) => {
      f.evidence.acp_clock_probe.sample.started_at = 1590;
    },
  ],
  [
    "wrong process host",
    (f) => {
      f.coarse.resource[1] = "foreign";
    },
  ],
  [
    "foreign candidate process",
    (f) => {
      f.traces
        .get(f.clockSearches.found[1].traceID)
        .processes.acp.tags.find((t) => t.key === "process.pid").value = 99;
      syncOutageClockSearch(f);
    },
  ],
  [
    "ambiguous candidate",
    (f) => {
      const t = f.health(92, 1704);
      f.traces.set(t.traceID, t);
      f.archivedTraceIDs.add(t.traceID);
      syncOutageClockSearch(f);
    },
  ],
  [
    "empty probe interval",
    (f) => {
      f.coarse.offset_min_us = f.epoch + 100000;
      f.coarse.offset_max_us = f.epoch + 101000;
    },
  ],
  [
    "SDK upper bound only touches send",
    (f) => {
      f.coarse.offset_min_us = f.epoch + 4000;
      f.coarse.offset_max_us = f.epoch + 5000;
    },
  ],
  [
    "SDK upper bound only touches receive",
    (f) => {
      f.coarse.offset_min_us = f.epoch - 4000;
      f.coarse.offset_max_us = f.epoch - 3000;
    },
  ],
  [
    "inconsistent HTTP Date",
    (f) => {
      f.evidence.acp_clock_probe.sample.server_date = new Date(
        f.epoch / 1000 + 7000,
      ).toUTCString();
    },
  ],
  [
    "unread search page",
    (f) => {
      f.clockSearches.errors = ["unread Jaeger search page"];
    },
  ],
  [
    "too few snapshots",
    (f) => {
      f.clockSearches.rounds.pop();
    },
  ],
  [
    "late raw warning with unchanged IDs",
    (f) => {
      f.clockSearches.rounds[0][1].warnings = ["late warning"];
    },
  ],
  [
    "changed archived raw",
    (f) => {
      f.traces.get(f.clockSearches.found[1].traceID).warnings = [
        "changed warning",
      ];
    },
  ],
  [
    "search candidate not archived",
    (f) => {
      f.archivedTraceIDs.delete(f.clockSearches.found[1].traceID);
    },
  ],
  [
    "archive-only health receiver",
    (f) => {
      const t = f.health(92, 800);
      f.traces.set(t.traceID, t);
      f.archivedTraceIDs.add(t.traceID);
    },
  ],
  [
    "duplicate search ID",
    (f) => {
      f.clockSearches.found.push(f.clockSearches.found[1]);
    },
  ],
  [
    "duplicate health receiver",
    (f) => {
      const t = f.traces.get(f.clockSearches.found[1].traceID),
        s = structuredClone(t.spans[0]);
      s.spanID = "f".repeat(16);
      t.spans.push(s);
      syncOutageClockSearch(f);
    },
  ],
  [
    "invented parent",
    (f) => {
      const t = f.traces.get(f.clockSearches.found[1].traceID);
      t.spans[0].references = [
        {
          refType: "FOLLOWS_FROM",
          traceID: "e".repeat(32),
          spanID: "f".repeat(16),
        },
      ];
      syncOutageClockSearch(f);
    },
  ],
  [
    "unmatched status receiver",
    (f) => {
      const t = f.traces.get(f.clockSearches.found[1].traceID);
      setTag(t.spans[0], "http.route", "unmatched");
      syncOutageClockSearch(f);
    },
  ],
  [
    "query does not cover complete possible probe",
    (f) => {
      f.clockSearches.query.lookback = "58000ms";
    },
  ],
  [
    "changed query service",
    (f) => {
      f.clockSearches.query.service = "agent-ui";
    },
  ],
])
  test(`outage health admission rejects ${name}`, () => {
    const f = outageClockFixture();
    change(f);
    assert.throws(() => check(f));
  });

test("an unrelated archived health outside the exact query range is not silently selected", () => {
  const f = outageClockFixture(),
    t = f.health(92, -6000);
  f.traces.set(t.traceID, t);
  f.archivedTraceIDs.add(t.traceID);
  assert.equal(check(f).source_trace_id, f.clockSearches.found[1].traceID);
});
test("workspace health in the same archive does not belong to the independent control query", () => {
  const f = outageClockFixture(),
    t = f.health(92, 1703);
  setTag(t.spans[0], "antnest.listener", "workspace");
  f.traces.set(t.traceID, t);
  f.archivedTraceIDs.add(t.traceID);
  assert.equal(check(f).source_trace_id, f.clockSearches.found[1].traceID);
});

async function capture(search, options = {}) {
  const f = outageClockFixture(),
    queries = [],
    retained = [],
    waits = [];
  const result = await searchOutageACPClock("http://jaeger", {
    now: f.clockSearches.now,
    lookback: f.clockSearches.query.lookback,
    signal: AbortSignal.timeout(10000),
    search: async (base, query, opts) => {
      queries.push({ query: Object.fromEntries(query), now: opts.now });
      return search(f, queries.length);
    },
    wait: async (...args) => {
      waits.push(args[0]);
    },
    retainID: (id) => retained.push(id),
    ...options,
  });
  return { result, queries, retained, waits, f };
}
test("independent health search waits for three identical raw snapshots with fixed bounds", async () => {
  const { result, queries, retained } = await capture((f, round) => {
    const rows = structuredClone(f.clockSearches.found);
    if (round === 1) rows[1].warnings = ["old raw warning"];
    return rows;
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.rounds.length, 4);
  assert(
    queries.every((q) => JSON.stringify(q) === JSON.stringify(queries[0])),
  );
  assert.equal(new Set(retained).size, 2);
  assert.equal(result.query.limit, "500");
});
for (const [name, read] of [
  ["empty inventory", () => []],
  [
    "500 results",
    (f) => Array.from({ length: 500 }, (_, i) => f.health(100 + i, 1703)),
  ],
  ["duplicate IDs", (f) => [f.health(90, 1703), f.health(90, 1703)]],
  [
    "unread page",
    () => {
      throw new Error("unread Jaeger search page");
    },
  ],
])
  test(`health capture retains failure for ${name}`, async () => {
    const { result } = await capture(read);
    assert(result.errors.length > 0);
  });
test("search failure after a successful round retains earlier candidates", async () => {
  const { result, retained } = await capture((f, round) => {
    if (round > 1) throw new Error("search unavailable");
    return f.clockSearches.found;
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.rounds.length, 1);
  assert.equal(result.found.length, 2);
  assert.equal(new Set(retained).size, 2);
});

test("outage probe joins complete body and second lifecycle inspection before restart", async () => {
  const f = outageClockFixture(),
    calls = [];
  const result = await captureOutageACPClock({
    before: f.evidence.acp_clock_probe.before,
    signal: AbortSignal.timeout(10000),
    clockProbe: async ({ container }) => {
      calls.push("probe");
      assert.equal(container, f.evidence.acp_clock_probe.before.id);
      return f.evidence.acp_clock_probe.sample;
    },
    inspectOwned: async () => {
      calls.push("inspect");
      return f.evidence.acp_clock_probe.after;
    },
  });
  assert.deepEqual(calls, ["probe", "inspect"]);
  assert.deepEqual(result, f.evidence.acp_clock_probe);
});
for (const badInspection of [false, true])
  test(
    "outage probe retains completed observations when later inspection fails: " +
      badInspection,
    async () => {
      const f = outageClockFixture(),
        records = [];
      await assert.rejects(
        captureOutageACPClock({
          before: f.evidence.acp_clock_probe.before,
          signal: AbortSignal.timeout(10000),
          clockProbe: async () => f.evidence.acp_clock_probe.sample,
          inspectOwned: async () => {
            if (!badInspection) throw new Error("inspection unavailable");
            return { ...f.evidence.acp_clock_probe.after, running: false };
          },
          record: (r) => records.push(structuredClone(r)),
        }),
      );
      assert.deepEqual(
        records.at(-1).sample,
        f.evidence.acp_clock_probe.sample,
      );
      if (badInspection) assert.equal(records.at(-1).after.running, false);
    },
  );
