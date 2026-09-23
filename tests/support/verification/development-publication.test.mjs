import assert from "node:assert/strict";
import test from "node:test";
import {
  publicationTrace,
  lifecycleOrganization,
} from "../fixtures/development-lifecycle.mjs";
import {
  inspectPublication,
  selectPublications,
} from "../../e2e/development/publication.mjs";

test("publication cutoff filters search and is rechecked against collected details", () => {
  const old = publicationTrace(4);
  old.spans[0].startTime = 999;
  const current = [1, 2, 3].map((n) => publicationTrace(n));
  assert.deepEqual(selectPublications([old, ...current], 1000), current);
  assert.throws(
    () =>
      inspectPublication(
        old,
        old.traceID,
        lifecycleOrganization,
        [],
        () => {},
        1000,
      ),
    /cutoff/,
  );
  assert.equal(
    inspectPublication(
      current[0],
      current[0].traceID,
      lifecycleOrganization,
      [],
      () => {},
      1000,
    ).strict_trace,
    "passed",
  );
});

test("publication selection preserves three independent roots, excluding nested attempts", () => {
  const roots = [1, 2, 3].map(publicationTrace),
    nested = publicationTrace(4);
  nested.spans.push({
    ...structuredClone(nested.spans[0]),
    spanID: "parent",
    operationName: "parent",
  });
  nested.spans[0].references.push({
    refType: "CHILD_OF",
    traceID: nested.traceID,
    spanID: "parent",
  });
  assert.deepEqual(selectPublications([nested, ...roots]), roots);
  assert.throws(
    () => selectPublications([roots[0], roots[0], roots[1]]),
    /distinct/,
  );
  assert.throws(() => selectPublications(roots.slice(0, 2)), /three/);
});

test("publication oracle retains source, acknowledgement, HTTP and strict-warning evidence", () => {
  const trace = publicationTrace();
  const result = inspectPublication(
    trace,
    trace.traceID,
    lifecycleOrganization,
    [],
  );
  assert.equal(result.source_reads, 1);
  assert.equal(result.acknowledgement_writes, 1);
  assert.equal(result.strict_trace, "passed");
  trace.spans[0].warnings = ["clock skew adjustment disabled; fixture"];
  assert.equal(
    inspectPublication(trace, trace.traceID, lifecycleOrganization, [])
      .strict_trace,
    "failed",
  );
});

test("publication saves diagnostic raw after structural checks and before rejecting unexpected warnings", () => {
  const trace = publicationTrace();
  trace.spans[0].warnings = ["unexpected warning"];
  let saved = 0;
  assert.throws(
    () =>
      inspectPublication(
        trace,
        trace.traceID,
        lifecycleOrganization,
        [],
        () => saved++,
      ),
    /unexpected publication warning/,
  );
  assert.equal(saved, 1);
  trace.spans = trace.spans.filter((s) => s.spanID !== "source");
  saved = 0;
  assert.throws(() =>
    inspectPublication(
      trace,
      trace.traceID,
      lifecycleOrganization,
      [],
      () => saved++,
    ),
  );
  assert.equal(saved, 0);
});

for (const [name, change] of [
  [
    "wrong trace",
    (t) => {
      t.traceID = "f".repeat(32);
      for (const span of t.spans) {
        span.traceID = t.traceID;
        for (const ref of span.references) ref.traceID = t.traceID;
      }
    },
  ],
  ["wrong organization", (t) => (t.spans[0].tags[0].value = "foreign")],
  [
    "missing source",
    (t) => (t.spans = t.spans.filter((s) => s.spanID !== "source")),
  ],
  [
    "duplicate acknowledgement",
    (t) => t.spans.push({ ...structuredClone(t.spans.at(-1)), spanID: "ack2" }),
  ],
  [
    "HTTP failure",
    (t) => (t.spans.find((s) => s.spanID === "client").tags[0].value = 503),
  ],
  [
    "revision mismatch",
    (t) => (t.spans.find((s) => s.spanID === "client").tags[1].value = 900),
  ],
  ["error span", (t) => t.spans[0].tags.push({ key: "error", value: true })],
  ["unexpected warning", (t) => (t.spans[0].warnings = ["missing parent"])],
  [
    "captured payload",
    (t) =>
      (t.spans[0].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ]),
  ],
])
  test(`publication oracle rejects ${name}`, () => {
    const trace = publicationTrace(),
      id = trace.traceID;
    change(trace);
    assert.throws(() =>
      inspectPublication(trace, id, lifecycleOrganization, []),
    );
  });
