import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { costPricingFixture } from "./pricing-collector.fixture.mjs";
import { costCollectorFixture } from "./collector.fixture.mjs";
import { costControlTraceFixture } from "./control-trace.fixture.mjs";
import { costSessionTraceFixture } from "./session-trace.fixture.mjs";
import { collectPrivateCostTrace } from "./collector.mjs";
import {
  setTag,
  sourceID,
  triggerID,
} from "../observability/gateway-resolution-fixtures.mjs";

const url = new URL("./pricing-collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
    return {};
  throw error;
});
const available = () =>
  assert.equal(typeof implementation.collectCostPricingTrace, "function");
const collect = (f) =>
  implementation.collectCostPricingTrace(
    "http://jaeger:16686",
    f.expected,
    f.options,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archive = (f) =>
  join(
    f.directory,
    readdirSync(f.directory).find((name) => name.startsWith("cost-pricing-")),
  );
const manifest = (f) =>
  JSON.parse(readFileSync(join(archive(f), "manifest.private.json"), "utf8"));
function verifyRaw(f) {
  const saved = manifest(f);
  assert.equal(statSync(archive(f)).mode & 0o777, 0o700);
  for (const query of saved.queries) {
    const path = join(archive(f), query.file);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, query.bytes);
    assert.equal(hash(bytes), query.sha256);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  return saved;
}
const acp = (t, { rejection = false, warning } = {}) => {
  const base = rejection
    ? costControlTraceFixture({ method: "session/new" })
    : costSessionTraceFixture();
  if (warning) {
    base.transaction.duration =
      base.application.startTime +
      base.application.duration +
      261 -
      base.transaction.startTime;
    base.transaction.warnings = [warning];
    const process = base.trace.processes[base.transaction.processID];
    if (!process.tags.some((tag) => tag.key === "process.runtime.name"))
      process.tags.push({ key: "process.runtime.name", value: "nodejs" });
  }
  const f = costCollectorFixture(t, base);
  return collectPrivateCostTrace("http://jaeger", f.expected, f.options);
};
for (const target of ["main", "source", "refresh"])
  for (const level of ["WARN", "ERROR", "FATAL"])
    test(`Cost pricing refuses original ${level} log on ${target}`, async (t) => {
      available();
      const f = costPricingFixture(t);
      const id =
        target === "main"
          ? f.expected.traceID
          : target === "source"
            ? sourceID
            : triggerID;
      const span = f.traces.get(id).spans[0];
      span.logs.push({
        timestamp: span.startTime,
        fields: [{ key: "level", value: level }],
      });
      await assert.rejects(collect(f));
      assert.equal(verifyRaw(f).outcome, "failed");
    });
for (const source of ["rpc", "cache", "shared", "shared-background"])
  for (const revision of [false, true])
    test(`Cost pricing ${source} ${revision ? "revision" : "Provider creation"} keeps complete Resolve sources and committed Model SQL`, async (t) => {
      available();
      const f = costPricingFixture(t, source, revision);
      const before = structuredClone([...f.traces]);
      const result = await collect(f);
      assert.deepEqual([...f.traces], before);
      assert.equal(result.persistence, true);
      assert.equal(result.gateway_console_ancestry, true);
      assert.equal(result.route, f.expected.route);
      assert.equal(result.strict_trace, "passed");
      assert.deepEqual(new Set(f.calls), new Set(f.traces.keys()));
      assert.deepEqual(f.waits, [6000, 1000, 1000]);
      assert.equal(
        implementation.costStrictOutcome([await acp(t)], [result]).exit_code,
        0,
      );
      const saved = verifyRaw(f);
      assert.equal(saved.outcome, "complete");
      assert.equal(saved.queries.length, f.calls.length);
      for (const query of saved.queries) {
        assert.equal(query.status, 200);
        assert.equal(query.body_complete, true);
        assert.equal(query.outcome, "complete");
        const id = new URL(query.url).pathname.split("/").at(-1);
        assert.deepEqual(readFileSync(join(archive(f), query.file)), f.raw(id));
      }
    });
for (const target of ["main", "source", "refresh"]) {
  for (const fault of ["reset", "abort"])
    test(`Cost pricing archives partial ${target} bytes and ${fault} before parsing`, async (t) => {
      available();
      const f = costPricingFixture(t);
      const id =
        target === "main"
          ? f.expected.traceID
          : target === "source"
            ? sourceID
            : triggerID;
      assert(f.traces.has(id));
      const original = f.options.request;
      const controller = new AbortController();
      const reason = new Error("PRIVATE-PRICING-SECRET");
      const bytes = Buffer.from([0x7b, 0x22, 0xe6, 0x88]);
      let sent = false,
        cancelled = false;
      f.options.signal = controller.signal;
      f.options.request = async (url, options) => {
        if (!url.endsWith(id)) return original(url, options);
        return new Response(
          new ReadableStream({
            pull(stream) {
              if (!sent) {
                sent = true;
                stream.enqueue(bytes);
              } else if (fault === "abort") controller.abort(reason);
              else stream.error(reason);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 502 },
        );
      };
      await assert.rejects(collect(f), (error) =>
        fault === "abort"
          ? error === reason
          : error.message === "Cost pricing collection failed",
      );
      const saved = verifyRaw(f);
      assert.equal(saved.outcome, fault === "abort" ? "aborted" : "failed");
      const query = saved.queries.at(-1);
      assert.equal(query.status, 502);
      assert.equal(query.body_complete, false);
      assert.equal(query.outcome, saved.outcome);
      assert.deepEqual(readFileSync(join(archive(f), query.file)), bytes);
      if (fault === "abort") assert.equal(cancelled, true);
    });
}
for (const [name, mutate] of [
  [
    "missing Model SQL",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.write);
    },
  ],
  [
    "uncommitted write",
    (f) => {
      setTag(
        f.trace.spans.find((s) => s.spanID === "transaction"),
        "antnest.transaction.outcome",
        "rolled_back",
      );
    },
  ],
  [
    "wrong Console parent",
    (f) => {
      f.controller.references[0].spanID = "upstream";
    },
  ],
  [
    "foreign route",
    (f) => {
      f.expected.route = "/internal/other";
    },
  ],
  [
    "source secret",
    (f) => {
      f.traces.get(sourceID).spans[0].tags.push({
        key: "private",
        value: "PRIVATE-PRICING-SECRET",
      });
    },
  ],
  [
    "refresh SQL parameter",
    (f) => {
      f.traces
        .get(triggerID)
        .spans[0].tags.push({ key: "db.query.parameters.x", value: "private" });
    },
  ],
  [
    "source exception",
    (f) => {
      f.traces.get(sourceID).spans[0].logs.push({
        timestamp: 1,
        fields: [{ key: "exception.type", value: "failed" }],
      });
    },
  ],
  [
    "refresh warning",
    (f) => {
      f.traces.get(triggerID).warnings = [
        "clock skew adjustment disabled; not applying calculated delta of 3µs",
      ];
    },
  ],
])
  test(`Cost pricing refuses ${name} and preserves the failed raw archive`, async (t) => {
    available();
    const f = costPricingFixture(t);
    mutate(f);
    await assert.rejects(collect(f));
    assert.equal(verifyRaw(f).outcome, "failed");
  });
test("Cost pricing preserves complete malformed body and status on failure", async (t) => {
  available();
  const f = costPricingFixture(t);
  const raw = "{invalid 原始";
  f.options.request = async () => new Response(raw, { status: 503 });
  await assert.rejects(collect(f));
  const query = verifyRaw(f).queries[0];
  assert.equal(query.status, 503);
  assert.equal(query.body_complete, true);
  assert.equal(readFileSync(join(archive(f), query.file), "utf8"), raw);
});
test("Cost pricing rechecks every source in the third stability sample", async (t) => {
  available();
  const f = costPricingFixture(t);
  let waits = 0;
  f.options.wait = async () => {
    if (++waits === 3) f.traces.get(sourceID).fixture_note = "changed";
  };
  await assert.rejects(collect(f));
  assert.equal(verifyRaw(f).outcome, "failed");
});
test("Cost final outcome retains private ACP exit 2 and rejects every pricing diagnostic or missing proof", async (t) => {
  available();
  const f = costPricingFixture(t);
  const result = await collect(f);
  const warning =
    "clock skew adjustment disabled; not applying calculated delta of -517.433µs";
  const privateWarning = await acp(t, { warning });
  assert.equal(
    implementation.costStrictOutcome([privateWarning], [result]).exit_code,
    2,
  );
  const clean = await acp(t);
  for (const change of [
    { warning_count: 1, warnings: [warning], strict_trace: "failed" },
    { error_spans: 1, strict_trace: "failed" },
    { pricing_trace_verified: false },
    { diagnostic_inventory_verified: false },
    { strict_trace: "failed" },
  ])
    assert.equal(
      implementation.costStrictOutcome([clean], [{ ...result, ...change }])
        .exit_code,
      1,
    );
  assert.equal(implementation.costStrictOutcome([clean], []).exit_code, 1);
  assert.equal(
    implementation.costStrictOutcome([structuredClone(clean)], [result])
      .exit_code,
    1,
  );
  assert.equal(
    implementation.costStrictOutcome(
      [await acp(t, { rejection: true })],
      [result],
    ).exit_code,
    2,
  );
});
