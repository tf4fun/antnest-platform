import assert from "node:assert/strict";
import test from "node:test";
import { inspectResolveLoad } from "./resolve-cache-load.mjs";
import { loadFixture } from "./resolve-cache-load-fixtures.mjs";
import { addLoadCleanup } from "./resolve-cache-load-close-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const inspect = (f) => inspectResolveLoad(f.wire, f.agentID, f.settings, f);
const fixture = () => addLoadCleanup(loadFixture());
const stream = (f, id = "private-watch") =>
  f.traces.get(f.wire.requests[0].trace_id).spans.find((s) => s.spanID === id);

test("load cannot pass without actual owner stop and private protocol closure", () => {
  assert.throws(() => inspect(loadFixture()), /owner drain receipt/u);
});
test("load cleanup keeps raw errors and classifies each exact initial-owner stream", () => {
  const f = fixture(),
    raw = JSON.stringify([...f.traces.values()]);
  const result = inspect(f);
  assert.equal(result.error_spans, 2);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.owner_cleanup.close_trace_id, f.close.traceID);
  assert.equal(result.owner_cleanup.delete_span_id, "delete");
  assert.equal(result.owner_cleanup.streams.length, 2);
  assert.equal(result.owner_cleanup.classified_errors.length, 2);
  assert.equal(result.owner_cleanup.clock.business_samples.length, 100);
  assert.equal(JSON.stringify([...f.traces.values()]), raw);
});

for (const [name, mutate] of [
  [
    "missing actual lifecycle",
    (f) => {
      delete f.ownerLifecycle;
    },
  ],
  [
    "missing authenticated organization",
    (f) => {
      delete f.ownerScope.organization_id;
    },
  ],
  [
    "different Agent lifecycle",
    (f) => {
      f.ownerLifecycle.agent_id = "another-agent";
    },
  ],
  [
    "missing close inventory",
    (f) => {
      f.cleanupSearches.close = [];
    },
  ],
  [
    "missing DELETE inventory",
    (f) => {
      f.cleanupSearches.delete = [];
    },
  ],
  [
    "missing health inventory",
    (f) => {
      f.cleanupSearches.health = [];
    },
  ],
  [
    "unarchived health Trace",
    (f) => {
      f.archivedTraceIDs.delete(f.health.traceID);
    },
  ],
  [
    "unarchived close Trace",
    (f) => {
      f.archivedTraceIDs.delete(f.close.traceID);
    },
  ],
  [
    "close link to Gateway rather than actual UI",
    (f) => {
      f.close.spans[0].references[0].spanID = "root";
    },
  ],
  [
    "close link to another HTTP request",
    (f) => {
      f.close.spans[0].references[0].traceID = f.wire.requests[1].trace_id;
    },
  ],
  [
    "no close link",
    (f) => {
      f.close.spans[0].references = [];
    },
  ],
  [
    "extra close link",
    (f) => {
      f.close.spans[0].references.push({ ...f.close.spans[0].references[0] });
    },
  ],
  [
    "transport failure close",
    (f) =>
      setTag(
        f.close.spans[0],
        "antnest.ui.acp.close.trigger",
        "transport_failure",
      ),
  ],
  [
    "no-target close",
    (f) =>
      setTag(f.close.spans[0], "antnest.ui.acp.close.outcome", "no_target"),
  ],
  [
    "DELETE failure",
    (f) => setTag(f.close.spans[1], "http.response.status_code", 500),
  ],
  [
    "DELETE invented CLIENT",
    (f) => setTag(f.close.spans[1], "span.kind", "client"),
  ],
  [
    "different ACP process",
    (f) => {
      f.close.processes.acp.tags = fields({
        "service.instance.id": "other-process",
      });
    },
  ],
  [
    "DELETE completed before stop",
    (f) => {
      f.close.spans[1].startTime -= 1000000;
    },
  ],
  [
    "stream completed before stop",
    (f) => {
      stream(f).duration -= 1000000;
    },
  ],
  [
    "clock interval only overlaps stop",
    (f) => {
      const s = stream(f);
      s.duration = 7991000 - s.startTime;
    },
  ],
  [
    "stream completed after container stopped",
    (f) => {
      stream(f).duration += 1000000;
    },
  ],
  [
    "warm request owner",
    (f) => {
      stream(f).references[0].spanID = "list";
    },
  ],
  [
    "wrong watch Agent",
    (f) => setTag(stream(f), "antnest.agent.id", "other-agent"),
  ],
  [
    "wrong watch organization",
    (f) => setTag(stream(f), "antnest.organization.id", "other-org"),
  ],
  [
    "process shutdown",
    (f) => setTag(stream(f), "antnest.stream.termination", "process-shutdown"),
  ],
  [
    "access revocation",
    (f) => {
      stream(f).logs.push({
        fields: fields({
          event: "antnest.stream.termination",
          reason: "access_denied",
        }),
      });
    },
  ],
  [
    "delivery timeout",
    (f) => setTag(stream(f), "error.type", "StateDeliveryTimeoutError"),
  ],
  [
    "hidden duplicate diagnostic",
    (f) => {
      stream(f).tags.push({ key: "error.type", value: "OtherError" });
    },
  ],
  [
    "extra error phase",
    (f) => setTag(stream(f), "antnest.error.phase", "agent.execution_state"),
  ],
  [
    "extra error message",
    (f) => setTag(stream(f), "error.message", "another failure"),
  ],
  ["missing ERROR status", (f) => setTag(stream(f), "otel.status_code", "OK")],
  [
    "unrelated SQL error",
    (f) =>
      setTag(
        f.traces
          .get(f.wire.requests[1].trace_id)
          .spans.find((s) => s.spanID === "list-sql"),
        "error",
        true,
      ),
  ],
])
  test(`load cleanup rejects ${name}`, () => {
    const f = fixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("load cleanup inventories every GET and watch, without clearing warnings", () => {
  const f = fixture(),
    first = f.traces.get(f.wire.requests[0].trace_id);
  const extra = structuredClone(stream(f, "private-get"));
  extra.spanID = "reconnected-get";
  extra.warnings = ["raw timing warning remains"];
  first.spans.push(extra);
  const result = inspect(f);
  assert.equal(result.owner_cleanup.streams.length, 3);
  assert.equal(result.owner_cleanup.classified_errors.length, 3);
  assert.equal(result.error_spans, 3);
  assert.equal(result.strict_trace, "failed");
  assert(result.warnings.includes("raw timing warning remains"));
});

test("watch may finish before SDK close starts; UI and ACP wall clocks are not compared", () => {
  const f = fixture();
  f.close.spans[0].startTime += 1000000000;
  assert.equal(inspect(f).owner_cleanup.classified_errors.length, 2);
});

for (const [name, mutate] of [
  [
    "DELETE already in flight before stop",
    (f) => {
      f.close.spans[1].startTime -= 50000;
      f.close.spans[1].duration += 50000;
    },
  ],
  ...[
    ["antnest.result", "rejected"],
    ["antnest.cancellation.type", "UnexpectedError"],
    ["antnest.http.request_cancelled", true],
    ["outcome", "failed"],
    ["db.response.status_code", "failed"],
  ].map(([key, value]) => [
    `extra ${key}`,
    (f) => setTag(stream(f), key, value),
  ]),
  ...["close", "delete"].flatMap((id) => [
    [
      `${id} unmarked exception event`,
      (f) =>
        f.close.spans
          .find((s) => s.spanID === id)
          .logs.push({
            fields: fields({
              event: "exception",
              "exception.type": "UnexpectedError",
            }),
          }),
    ],
    [
      `${id} unmarked exception tag`,
      (f) =>
        setTag(
          f.close.spans.find((s) => s.spanID === id),
          "exception.type",
          "UnexpectedError",
        ),
    ],
  ]),
])
  test(`load cleanup review rejects ${name}`, () => {
    const f = fixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });
