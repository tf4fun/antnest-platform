import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectPrivateCostTrace,
  privateCostStrictOutcome,
} from "./collector.mjs";
import { costCollectorFixture } from "./collector.fixture.mjs";
import { costSessionTraceFixture } from "./session-trace.fixture.mjs";
import { costControlTraceFixture } from "./control-trace.fixture.mjs";
import { costRunTraceFixture } from "./run-trace.fixture.mjs";

const warning =
  "clock skew adjustment disabled; not applying calculated delta of -517.433µs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const parse = (file) => JSON.parse(readFileSync(file, "utf8"));
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const collect = (f) =>
  collectPrivateCostTrace("http://jaeger", f.expected, f.options);
const outcome = (...results) => privateCostStrictOutcome(results);
const tags = (process) =>
  Object.fromEntries(process.tags.map(({ key, value }) => [key, value]));
const profiles = [
  { version: 1 },
  { version: 2 },
  { version: 1, http: true },
  { version: 1, http: true, sameSpan: true },
];

function deferredFixture(t, profile = {}) {
  const f = costSessionTraceFixture(profile);
  f.transaction.duration =
    f.application.startTime +
    f.application.duration +
    261 -
    f.transaction.startTime;
  f.transaction.warnings = [warning];
  const process = f.trace.processes[f.transaction.processID];
  if (!Object.hasOwn(tags(process), "process.runtime.name"))
    process.tags.push({ key: "process.runtime.name", value: "nodejs" });
  return costCollectorFixture(t, f);
}

test("Cost warning admission fixtures use real OTLP Span identity shapes", (t) => {
  for (const profile of profiles)
    for (const make of [
      costSessionTraceFixture,
      costControlTraceFixture,
      costRunTraceFixture,
    ]) {
      const f = costCollectorFixture(t, make(profile));
      for (const trace of f.raw.values())
        for (const span of trace.spans) {
          assert.match(span.spanID, /^[a-f0-9]{16}$/u);
          for (const reference of span.references)
            assert.match(reference.spanID, /^[a-f0-9]{16}$/u);
        }
    }
});

for (const profile of profiles)
  test(`Cost warning admission binds an actual owning sub-ms observation ${JSON.stringify(profile)}`, async (t) => {
    const f = deferredFixture(t, profile);
    const original = structuredClone([...f.raw]);
    const result = await collect(f);
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.warning_count, 1);
    assert.deepEqual(result.warnings, [warning]);
    assert(
      result.time_observations.some(
        (item) =>
          item.span_id === f.transaction.spanID &&
          (item.parent_span_id ?? item.next_span_id) === f.application.spanID &&
          item.raw_difference_us === 261 &&
          item.reason === "deferred-same-node-sdk-sub-ms-endpoint",
      ),
    );
    assert.equal(result.cost_warning_review.deferred_warning_count, 1);
    assert.equal(result.complete_source_receipt.samples.length, 3);
    const reviewed = outcome(result);
    assert.equal(reviewed.accepted, true);
    assert.equal(reviewed.exit_code, 2);
    assert.equal(reviewed.strict_trace, "failed");
    assert.equal(reviewed.reviewed_warning_occurrences, 1);
    assert.deepEqual([...f.raw], original);
    const file = join(
      result.evidence_directory,
      "cost-warning-review.private.json",
    );
    const bytes = readFileSync(file);
    const proof = JSON.parse(bytes);
    assert.equal(hash(bytes), result.cost_warning_review.review_sha256);
    assert.equal(proof.samples.length, 3);
    for (const [index, sample] of proof.samples.entries()) {
      const receipt = result.complete_source_receipt.samples[index];
      assert.equal(sample.attempt, receipt.attempt);
      assert.equal(
        sample.source_snapshot_sha256,
        receipt.source_snapshot_sha256,
      );
      assert.equal(sample.policy.warning_count, 1);
      assert.equal(sample.policy.inventory[0].span_id, f.transaction.spanID);
      assert.equal(sample.policy.inventory[0].warning, warning);
    }
    assert.deepEqual(
      parse(join(result.evidence_directory, "result.json")),
      JSON.parse(JSON.stringify(result)),
    );
  });

for (const target of ["main", "connection", "initialize", "GET", "DELETE"])
  test(`Cost warning admission refuses the first unproved ${target} warning before later clean samples`, async (t) => {
    const http = target !== "connection";
    const f = costCollectorFixture(t, costSessionTraceFixture({ http }));
    const id =
      target === "main"
        ? f.trace.traceID
        : target === "connection"
          ? f.connectionTrace.traceID
          : f.expected.httpConnection.requests.find((item) =>
              target === "initialize"
                ? item.rpcMethod === target
                : item.method === target,
            ).traceID;
    const source = f.raw.get(id);
    source.warnings = [warning];
    let waits = 0;
    f.options.attempts = 5;
    f.options.wait = async () => {
      waits++;
      source.warnings = [];
    };
    // Caller options must not override the fixed owning warning policy.
    f.options.inspectCompleteSources = () => {};
    await assert.rejects(collect(f));
    assert.equal(waits, 0);
    const directory = join(f.directory, readdirSync(f.directory)[0]);
    assert.equal(parse(join(directory, "manifest.json")).status, "failed");
    assert(!readdirSync(directory).includes("result.json"));
    assert(
      readFileSync(
        join(directory, "complete-source-failure.private.txt"),
        "utf8",
      ).includes("unattributed-warning"),
    );
  });

for (const fault of [
  "clone",
  "method",
  "timing",
  "claim",
  "projection",
  "missing receipt",
  "source SHA",
  "drop sample",
  "repeat sample",
  "raw",
  "raw and public SHA",
  "private policy",
  "saved result",
])
  test(`Cost warning admission rejects ${fault} changes after collection`, async (t) => {
    const f = costCollectorFixture(
      t,
      costControlTraceFixture({ method: "session/new" }),
    );
    const original = await collect(f);
    assert.equal(outcome(original).accepted, true);
    let result = original;
    const directory = result.evidence_directory;
    if (fault === "clone") result = structuredClone(result);
    if (fault === "method") result.method = "session/fork";
    if (fault === "timing") result.time_observations.push({ invented: true });
    if (fault === "claim")
      result.owned_error_spans[0].reason = "private-http-sse-close";
    if (fault === "projection")
      result.cost_warning_review = { deferred_warning_count: 0 };
    if (fault === "missing receipt") delete result.complete_source_receipt;
    if (fault === "source SHA")
      result.complete_source_receipt.source_snapshot_sha256 = "0".repeat(64);
    if (fault === "drop sample") result.complete_source_receipt.samples.pop();
    if (fault === "repeat sample")
      result.complete_source_receipt.samples[1] = structuredClone(
        result.complete_source_receipt.samples[0],
      );
    if (["raw", "raw and public SHA"].includes(fault)) {
      const manifest = parse(join(directory, "manifest.json"));
      const query = manifest.queries.at(-1);
      const file = join(directory, query.file);
      const bytes = Buffer.concat([readFileSync(file), Buffer.from(" ")]);
      writeFileSync(file, bytes);
      if (fault === "raw and public SHA") {
        query.sha256 = hash(bytes);
        query.bytes = bytes.length;
        writeFileSync(join(directory, "manifest.json"), encode(manifest));
        for (const sample of result.complete_source_receipt?.samples ?? [])
          for (const item of sample.queries)
            if (item.file === query.file) Object.assign(item, query);
      }
    }
    if (fault === "private policy")
      writeFileSync(
        join(directory, "cost-warning-review.private.json"),
        "{}\n",
      );
    if (fault === "saved result")
      writeFileSync(join(directory, "result.json"), "{}\n");
    assert.equal(outcome(result).accepted, false);
    assert.equal(outcome(result).exit_code, 1);
  });

test("Cost warning admission rejects repeat objects and separately collected replay of one business Trace", async (t) => {
  const f = costCollectorFixture(t, costSessionTraceFixture());
  const first = await collect(f),
    second = await collect(f);
  assert.equal(outcome(first).accepted, true);
  assert.equal(outcome(second).accepted, true);
  assert.equal(outcome(first, first).accepted, false);
  assert.equal(outcome(first, second).accepted, false);
});

test("Cost warning admission cannot borrow another genuine collection's receipt", async (t) => {
  const a = costCollectorFixture(t, costSessionTraceFixture());
  const b = costCollectorFixture(t, costSessionTraceFixture({ version: 2 }));
  const first = await collect(a),
    second = await collect(b);
  first.complete_source_receipt = structuredClone(
    second.complete_source_receipt,
  );
  first.cost_warning_review = structuredClone(second.cost_warning_review);
  assert.equal(outcome(first).accepted, false);
  assert.equal(outcome(second).accepted, true);
});

function siblingFixtures(t) {
  const first = costSessionTraceFixture({ method: "session/load" });
  const second = costSessionTraceFixture({ method: "session/load" });
  const old = second.trace.traceID,
    id = "d".repeat(32);
  second.trace.traceID = id;
  for (const span of second.trace.spans) {
    span.traceID = id;
    for (const reference of span.references)
      if (reference.traceID === old) reference.traceID = id;
  }
  second.expected.traceID = id;
  second.expected.requestId = "another-request";
  second.expected.requestReceipt.requestId = "another-request";
  second.set(second.request, "antnest.request.id", "another-request");
  return [costCollectorFixture(t, first), costCollectorFixture(t, second)];
}

for (const changed of [false, true])
  test(`Cost warning admission compares shared source bytes across business Traces; changed=${changed}`, async (t) => {
    const [a, b] = siblingFixtures(t);
    if (changed)
      for (const span of b.connectionTrace.spans) span.duration += 1000;
    const first = await collect(a),
      second = await collect(b);
    assert.equal(outcome(first).accepted, true);
    assert.equal(outcome(second).accepted, true);
    assert.equal(outcome(first, second).accepted, !changed);
  });

test("Cost warning admission binds the actual final three rounds after source drift", async (t) => {
  const f = costCollectorFixture(t, costSessionTraceFixture());
  f.options.attempts = 5;
  let waits = 0;
  f.options.wait = async () => {
    if (++waits === 1)
      f.connectionTrace.fixture_note = "late unchanged diagnostic content";
  };
  const result = await collect(f);
  const receipt = result.complete_source_receipt;
  assert.deepEqual(
    receipt.samples.map((sample) => sample.attempt),
    [2, 3, 4],
  );
  const proof = parse(
    join(result.evidence_directory, "cost-warning-review.private.json"),
  );
  assert.deepEqual(
    proof.samples.map((sample) => sample.attempt),
    [2, 3, 4],
  );
  assert(
    proof.samples.every(
      (sample) =>
        sample.source_snapshot_sha256 === receipt.source_snapshot_sha256,
    ),
  );
  assert.equal(outcome(result).accepted, true);
});

for (const rejection of [false, true])
  test(`Cost warning admission rejects report accessors that hide original diagnostics; rejection=${rejection}`, async (t) => {
    const f = rejection
      ? costCollectorFixture(
          t,
          costControlTraceFixture({ method: "session/new" }),
        )
      : deferredFixture(t);
    const result = await collect(f);
    assert.equal(outcome(result).exit_code, 2);
    const clean = {
      warning_count: 0,
      warnings: [],
      strict_trace: "passed",
      ...(rejection
        ? { raw_error_inventory: [], owned_error_spans: [], error_spans: 0 }
        : {}),
    };
    for (const [key, replacement] of Object.entries(clean)) {
      const original = result[key];
      let reads = 0;
      Object.defineProperty(result, key, {
        enumerable: true,
        configurable: true,
        get: () => (reads++ === 0 ? original : replacement),
      });
    }
    assert.equal(outcome(result).accepted, false);
  });

test("Cost warning admission rejects an asynchronous nested observation rewrite", async (t) => {
  const result = await collect(deferredFixture(t));
  assert.equal(outcome(result).exit_code, 2);
  await new Promise((resolve) =>
    queueMicrotask(() => {
      result.time_observations[0].raw_difference_us = 0;
      resolve();
    }),
  );
  assert.equal(outcome(result).accepted, false);
});

for (const profile of profiles)
  test(`Cost warning admission preserves propagated occurrences when Jaeger reorders spans ${JSON.stringify(profile)}`, async (t) => {
    const f = deferredFixture(t, profile);
    f.queries[0].warnings = [warning];
    f.options.wait = async () => {
      f.trace.spans.reverse();
    };
    const result = await collect(f);
    assert.equal(result.warning_count, 2);
    assert.equal(result.strict_trace, "failed");
    const strict = outcome(result);
    assert.equal(strict.exit_code, 2);
    assert.equal(strict.reviewed_warning_occurrences, 2);
    const proof = parse(
      join(result.evidence_directory, "cost-warning-review.private.json"),
    );
    assert.notDeepEqual(
      proof.samples[0].policy.inventory,
      proof.samples[1].policy.inventory,
    );
    assert.deepEqual(
      proof.samples[0].policy.inventory,
      proof.samples[2].policy.inventory,
    );
    for (const sample of proof.samples) {
      assert.equal(sample.policy.inventory.length, 2);
      assert.equal(sample.policy.sources.length, 1);
      assert.equal(sample.policy.sources[0].span_id, f.transaction.spanID);
      assert.equal(sample.policy.sources[0].occurrences.length, 2);
    }
  });
