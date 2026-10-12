import assert from "node:assert/strict";
import test from "node:test";
import { inspectCrashTrace } from "./crash-trace.mjs";
import { crashTrace, targetPresent } from "./crash-trace-fixtures.mjs";
test("crash trace reports raw missing parents while requiring complete successful recovery", () => {
  const f = crashTrace();
  const result = inspectCrashTrace(f.trace, f.expected);
  assert.equal(result.topology_scope, "completed_recovery");
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.crash_diagnostics.missing_parents.length, 1);
  assert.equal(result.attempts, 2);
  assert.equal(
    f.trace.spans.some((s) => s.spanID === "orphan"),
    true,
  );
});
for (const [name, mutate] of [
  [
    "new-process orphan",
    (f) => {
      f.trace.spans.at(-1).processID = "runtime-controller";
    },
  ],
  [
    "foreign orphan reference",
    (f) => {
      f.trace.spans.at(-1).references[0].traceID = "foreign";
    },
  ],
  [
    "changed child request",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "failed-client")
        .tags.find((t) => t.key === "antnest.operation.request_id").value =
        "wrong";
    },
  ],
  [
    "failed successful activity",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "lifecycle.publish")
        .tags.push({ key: "error", value: true });
    },
  ],
  [
    "missing successful parent",
    (f) => {
      f.trace.spans.find(
        (s) => s.spanID === "client-rpc-lifecycle.runtime_update",
      ).references[0].spanID = "missing";
    },
  ],
  [
    "duplicate span",
    (f) => {
      f.trace.spans.push(f.trace.spans[0]);
    },
  ],
  [
    "captured payload in crashed process",
    (f) => {
      f.trace.spans.at(-1).logs = [
        { fields: [{ key: "antnest.payload.json", value: "secret" }] },
      ];
    },
  ],
  [
    "extra retry",
    (f) => {
      const s = structuredClone(
        f.trace.spans.find((s) => s.spanID === "failed-attempt"),
      );
      s.spanID = "third";
      f.trace.spans.push(s);
    },
  ],
])
  test(`crash trace rejects ${name}`, () => {
    const f = crashTrace();
    mutate(f);
    assert.throws(() => inspectCrashTrace(f.trace, f.expected));
  });

test("existing-target recovery validates the narrow identity probe and rejects extra effects", () => {
  const f = targetPresent();
  assert.equal(inspectCrashTrace(f.trace, f.expected).strict_trace, "failed");
  const bad = targetPresent();
  bad.trace.spans.find((s) => s.spanID === "inspect").logs[0].fields[0].value =
    '["network timeout"]';
  assert.throws(() => inspectCrashTrace(bad.trace, bad.expected));
  const missing = targetPresent();
  missing.trace.spans = missing.trace.spans.filter(
    (s) => s.spanID !== "lifecycle.publish",
  );
  assert.throws(() => inspectCrashTrace(missing.trace, missing.expected));
});

for (const [name, change] of [
  [
    "extra Docker mutation",
    (f) => {
      const s = structuredClone(
        f.trace.spans.find((s) => s.spanID === "inspect"),
      );
      s.spanID = "extra-post";
      s.operationName = "HTTP POST docker";
      s.tags = [
        { key: "peer.service", value: "docker" },
        { key: "http.request.method", value: "POST" },
      ];
      delete s.logs;
      f.trace.spans.push(s);
    },
  ],
  [
    "foreign target error",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "inspect")
        .tags.find((t) => t.key === "antnest.agent.id").value = "foreign";
    },
  ],
  [
    "missing committed publication",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "sql-lifecycle.publish")
        .tags.find((t) => t.key === "db.operation.name").value = "SELECT";
    },
  ],
])
  test(`existing-target recovery rejects ${name}`, () => {
    const f = targetPresent();
    change(f);
    assert.throws(() => inspectCrashTrace(f.trace, f.expected));
  });

test("Controller downtime may add transport retries without another mutation attempt", () => {
  const f = crashTrace();
  for (const id of ["failed-attempt", "failed-client"]) {
    const s = structuredClone(f.trace.spans.find((s) => s.spanID === id));
    s.spanID = "downtime-" + id;
    s.startTime += 1;
    for (const r of s.references)
      if (r.spanID === "failed-attempt") r.spanID = "downtime-failed-attempt";
    f.trace.spans.push(s);
  }
  assert.equal(inspectCrashTrace(f.trace, f.expected).attempts, 3);
});
