import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { costCollectorFixture } from "./collector.fixture.mjs";
import { costControlTraceFixture } from "./control-trace.fixture.mjs";
import { costSessionTraceFixture } from "./session-trace.fixture.mjs";
import { costConfigurationTraceFixture } from "./configuration-trace.fixture.mjs";
import { costRunTraceFixture } from "./run-trace.fixture.mjs";

const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
    return {};
  throw error;
});
const available = () => {
  for (const name of [
    "collectPrivateCostTrace",
    "inspectPrivateCostTrace",
    "privateCostStrictOutcome",
  ])
    assert.equal(typeof implementation[name], "function");
};
const collect = (f) =>
  implementation.collectPrivateCostTrace(
    "http://jaeger",
    f.expected,
    f.options,
  );
const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owners = [
  ["initialize", (profile) => costControlTraceFixture(profile)],
  [
    "access refusal",
    (profile) => costControlTraceFixture({ ...profile, method: "session/new" }),
  ],
  [
    "Session refusal",
    (profile) =>
      costControlTraceFixture({ ...profile, method: "session/prompt" }),
  ],
  ["new", (profile) => costSessionTraceFixture(profile)],
  [
    "fork",
    (profile) =>
      costSessionTraceFixture({ ...profile, method: "session/fork" }),
  ],
  [
    "replay",
    (profile) =>
      costSessionTraceFixture({
        ...profile,
        method: profile.version === 2 ? "session/resume" : "session/load",
      }),
  ],
  ["configuration", (profile) => costConfigurationTraceFixture(profile)],
  ["Run", (profile) => costRunTraceFixture(profile)],
];
for (const profile of [
  { version: 1 },
  { version: 2 },
  { version: 1, http: true },
]) {
  for (const [name, make] of owners) {
    test(`Cost collector uses the owning ${name} oracle ${JSON.stringify(profile)}`, async (t) => {
      available();
      const f = costCollectorFixture(t, make(profile));
      const raw = structuredClone([...f.raw]);
      const result = await collect(f);
      assert.equal(result.diagnostic_inventory_verified, true);
      assert.equal(result.method, f.expected.method);
      assert.equal(result.runs, name === "Run" ? 1 : 0);
      const strict = implementation.privateCostStrictOutcome([result]);
      assert.equal(strict.accepted, true);
      assert.equal(
        strict.exit_code,
        result.error_spans || result.warning_count ? 2 : 0,
      );
      if (f.expected.rejection)
        assert.equal(
          result.owned_error_spans.filter(
            (item) => item.reason === "cost-rejection",
          ).length,
          2,
        );
      assert.deepEqual([...f.raw], raw);
      const manifest = parse(join(result.evidence_directory, "manifest.json"));
      assert.equal(manifest.status, "collected");
      assert.equal(statSync(result.evidence_directory).mode & 0o777, 0o700);
      assert(manifest.queries.length >= 3);
      for (const query of manifest.queries) {
        const path = join(result.evidence_directory, query.file),
          bytes = readFileSync(path);
        assert.equal(query.body_complete, true);
        assert.equal(query.sha256, hash(bytes));
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
    });
  }
}
test("Cost collector uses the separate observer list oracle", async (t) => {
  available();
  const f = costCollectorFixture(
    t,
    costConfigurationTraceFixture({ method: "session/list" }),
  );
  assert.equal((await collect(f)).list_read_only, true);
});
for (const fault of [
  "foreign Provider Trace with original phase",
  "wrong Provider phase on original Trace",
  "missing Provider receipt",
  "nonexecution Provider receipt",
  "unknown method",
  "missing initialization result",
  "missing Session transaction",
]) {
  test(`Cost collector rejects ${fault} and retains failed raw`, async (t) => {
    available();
    const base =
      fault === "missing initialization result"
        ? costControlTraceFixture()
        : [
              "nonexecution Provider receipt",
              "unknown method",
              "missing Session transaction",
            ].includes(fault)
          ? costSessionTraceFixture()
          : costRunTraceFixture();
    const f = costCollectorFixture(t, base);
    if (fault === "foreign Provider Trace with original phase")
      f.options.requests[0].trace_id = "foreign";
    if (fault === "wrong Provider phase on original Trace")
      f.options.requests[0].phase = "foreign";
    if (fault === "missing Provider receipt") f.options.requests.length = 0;
    if (fault === "nonexecution Provider receipt")
      f.options.requests.push({ trace_id: f.trace.traceID });
    if (fault === "unknown method") f.expected.method = "session/close";
    if (fault === "missing initialization result")
      delete f.expected.initializationResult;
    if (fault === "missing Session transaction")
      f.trace.spans = f.trace.spans.filter((span) => span !== f.transaction);
    await assert.rejects(collect(f));
    const archive = join(f.directory, readdirSync(f.directory)[0]);
    const manifest = parse(join(archive, "manifest.json"));
    assert.equal(manifest.status, "failed");
    assert(manifest.queries.length > 0);
    assert(
      manifest.queries.every(
        (query) =>
          query.sha256 === hash(readFileSync(join(archive, query.file))),
      ),
    );
  });
}
for (const fault of [
  "unclaimed error",
  "unknown reason",
  "rewritten strict status",
]) {
  test(`Cost strict result refuses ${fault}`, async (t) => {
    available();
    const f = costCollectorFixture(
      t,
      costControlTraceFixture({ method: "session/new" }),
    );
    const result = await collect(f);
    if (fault === "unclaimed error") result.owned_error_spans.pop();
    if (fault === "unknown reason")
      result.owned_error_spans[0].reason = "allowed";
    if (fault === "rewritten strict status") result.strict_trace = "passed";
    const strict = implementation.privateCostStrictOutcome([result]);
    assert.equal(strict.accepted, false);
    assert.equal(strict.exit_code, 1);
  });
}
