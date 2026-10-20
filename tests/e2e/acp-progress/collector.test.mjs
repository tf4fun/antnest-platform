import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costCollectorFixture } from "../acp-cost/collector.fixture.mjs";
import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { costSessionTraceFixture } from "../acp-cost/session-trace.fixture.mjs";
import { progressTraceFixture } from "./trace.fixture.mjs";
import {
  barrierTraceFixture,
  cancelTraceFixture,
} from "./control-trace.fixture.mjs";
const { privateNotificationExpectation } =
  await import("../identity-closeout/private-acp-notification.mjs");

const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function available() {
  for (const name of [
    "collectPrivateProgressTrace",
    "collectPrivateProgressNotificationTrace",
    "privateProgressStrictOutcome",
  ])
    assert.equal(typeof implementation[name], "function");
}
const collect = (f) =>
  implementation.collectPrivateProgressTrace(
    "http://jaeger",
    f.expected,
    f.options,
  );
const strict = (results) =>
  implementation.privateProgressStrictOutcome(results);
function failedArchive(f) {
  const archives = readdirSync(f.directory);
  assert.equal(archives.length, 1);
  const directory = join(f.directory, archives[0]);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json")));
  assert.equal(manifest.status, "failed");
  assert(manifest.queries.length > 0);
  assert(!readdirSync(directory).includes("result.json"));
}
const fixtures = [1, 2].flatMap((version) =>
  [
    ["initialize", () => costControlTraceFixture({ version })],
    ["new", () => costSessionTraceFixture({ version })],
    [
      "replay",
      () =>
        costSessionTraceFixture({
          version,
          method: version === 1 ? "session/load" : "session/resume",
        }),
    ],
    ["barrier", () => barrierTraceFixture(version)],
    ...["bash", "managed"].flatMap((source) =>
      ["success", "failure", "cancel"].map((ending) => {
        const phase = `v${version}-${source}-${ending}`;
        return [
          phase,
          () =>
            progressTraceFixture(phase, { heldDiscovery: ending !== "cancel" }),
        ];
      }),
    ),
  ].map(([name, make]) => [`v${version}:${name}`, make]),
);
for (const [name, make] of fixtures)
  test(`Progress collector archives and admits the actual ${name} owning proof`, async (t) => {
    available();
    const f = costCollectorFixture(t, make());
    const raw = structuredClone([...f.raw]);
    const result = await collect(f);
    assert.equal(result.method, f.expected.method);
    assert.equal(result.complete_source_receipt.stable_samples, 3);
    assert.equal(result.diagnostic_inventory_verified, true);
    assert.equal(strict([result]).accepted, true);
    assert.equal(
      strict([result]).exit_code,
      result.error_spans || result.warning_count ? 2 : 0,
    );
    assert.deepEqual([...f.raw], raw);
    assert.equal(strict([structuredClone(result)]).accepted, false);
    assert.equal(strict([result, result]).accepted, false);
    const archive = JSON.parse(
      readFileSync(join(result.evidence_directory, "manifest.json")),
    );
    assert.equal(archive.status, "collected");
    assert.equal(archive.attempts.length, 3);
  });
for (const version of [1, 2])
  test(`Progress collector binds the original v${version} cancel notification and complete archive`, async (t) => {
    available();
    const original = await cancelTraceFixture(t, version);
    const f = costCollectorFixture(t, {
      ...original,
      connectionTrace: original.connection,
      expected: privateNotificationExpectation(original.receipt),
    });
    const result = await implementation.collectPrivateProgressNotificationTrace(
      "http://jaeger",
      f.receipt,
      f.options,
    );
    assert.equal(result.cancellation_requested, true);
    assert.equal(result.actual_execution_stopped, undefined);
    assert.equal(result.notification_index, f.receipt.index);
    assert.equal(result.complete_source_receipt.stable_samples, 3);
    assert.equal(strict([result]).accepted, true);
    await assert.rejects(
      implementation.collectPrivateProgressNotificationTrace(
        "http://jaeger",
        structuredClone(f.receipt),
        f.options,
      ),
    );
    const manifest = JSON.parse(
      readFileSync(join(result.evidence_directory, "manifest.json")),
    );
    writeFileSync(
      join(result.evidence_directory, manifest.queries[0].file),
      "{}",
    );
    assert.equal(strict([result]).accepted, false);
  });
for (const source of ["notification", "connection"])
  test(`Progress cancellation rejects a Provider receipt on its original ${source} Trace`, async (t) => {
    available();
    const original = await cancelTraceFixture(t, 2);
    const f = costCollectorFixture(t, {
      ...original,
      connectionTrace: original.connection,
      expected: privateNotificationExpectation(original.receipt),
    });
    f.options.requests = [
      {
        trace_id:
          source === "notification"
            ? f.trace.traceID
            : f.connectionTrace.traceID,
        phase: "foreign",
      },
    ];
    await assert.rejects(
      implementation.collectPrivateProgressNotificationTrace(
        "http://jaeger",
        f.receipt,
        f.options,
      ),
    );
    failedArchive(f);
  });
test("Progress request rejects a Provider receipt on its original connection Trace", async (t) => {
  available();
  const f = costCollectorFixture(t, progressTraceFixture("v2-bash-success"));
  f.options.requests.push({
    trace_id: f.connectionTrace.traceID,
    phase: "foreign",
  });
  await assert.rejects(collect(f));
  failedArchive(f);
});
for (const [name, mutate] of [
  [
    "foreign Provider trace on original phase",
    (f) => {
      f.requests[0].trace_id = "f".repeat(32);
    },
  ],
  [
    "foreign phase on original Provider trace",
    (f) => {
      f.requests[0].phase = "foreign";
    },
  ],
  [
    "missing original Run",
    (f) => {
      f.trace.spans.splice(f.trace.spans.indexOf(f.run), 1);
    },
  ],
  [
    "unknown warning",
    (f) => {
      f.expected.connectionTrace.warnings = ["unreviewed warning"];
    },
  ],
  [
    "unproved cross-process clock warning",
    (f) => {
      f.expected.connectionTrace.spans[1].warnings = [
        "clock skew adjustment disabled; not applying calculated delta of -1ms",
      ];
    },
  ],
])
  test(`Progress collector rejects ${name} and preserves failed raw`, async (t) => {
    available();
    const original = progressTraceFixture("v2-bash-success");
    mutate(original);
    const f = costCollectorFixture(t, original);
    await assert.rejects(collect(f));
    failedArchive(f);
  });
test("Progress complete-source warning failure cannot disappear on later clean observations", async (t) => {
  available();
  const f = costCollectorFixture(t, progressTraceFixture("v2-bash-success"));
  let requests = 0;
  const request = f.options.request;
  f.options.request = async (...args) => {
    requests++;
    const response = await request(...args);
    if (new URL(args[0]).pathname.endsWith(f.trace.traceID)) {
      const body = await response.json();
      body.data[0].warnings = requests < 5 ? ["unreviewed warning"] : [];
      return Response.json(body);
    }
    return response;
  };
  await assert.rejects(collect(f));
  assert(requests < 5, "fixed owning warning rejection is fatal");
});
