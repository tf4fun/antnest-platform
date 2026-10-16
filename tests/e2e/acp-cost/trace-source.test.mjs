import assert from "node:assert/strict";
import test from "node:test";
import { costControlTraceFixture } from "./control-trace.fixture.mjs";
import { costSessionTraceFixture } from "./session-trace.fixture.mjs";
import { costConfigurationTraceFixture } from "./configuration-trace.fixture.mjs";
import { costRunTraceFixture } from "./run-trace.fixture.mjs";
import { inspectPrivateCostTrace as inspect } from "./collector.mjs";

const factories = [
  ["initialize", () => costControlTraceFixture()],
  ["rejection", () => costControlTraceFixture({ method: "session/load" })],
  ["Session", () => costSessionTraceFixture()],
  ["configuration", () => costConfigurationTraceFixture()],
  ["Run", () => costRunTraceFixture()],
];
const check = (f) => inspect(f.trace, f.expected, [], f.requests ?? []);
for (const [name, make] of factories) {
  for (const field of [
    "db.query.parameters",
    "db.query.parameters.token",
    "db.query.parameter",
    "db.query.result",
    "db.query.results.rows",
    "db.statement.parameters",
    "pgx.query.parameters",
    "db.connection_string",
  ])
    for (const location of ["tag", "event"])
      test(`Cost ${name} cannot export ${field} in ${location}`, () => {
        const f = make();
        check(f);
        const span =
          f.trace.spans.find((span) =>
            span.tags?.some(({ key }) => key === "db.query.text"),
          ) ?? f.request;
        const item = { key: field, value: "captured-value" };
        if (location === "tag") span.tags.push(item);
        else
          (span.logs ??= []).push({
            timestamp: span.startTime,
            fields: [item],
          });
        assert.throws(() => check(f));
      });
}
for (const http of [false, true]) {
  for (const target of http ? ["request", "client"] : ["request", "connection"])
    for (const invalid of [
      "negative duration",
      "NaN duration",
      "infinite start",
      "overflowing end",
    ])
      test(`Cost initialize rejects ${invalid} in ${target} (http=${http})`, () => {
        const f = costControlTraceFixture({ http });
        check(f);
        const span =
          target === "connection" ? f.connectionTrace.spans[0] : f[target];
        if (invalid === "negative duration") span.duration = -1;
        if (invalid === "NaN duration") span.duration = NaN;
        if (invalid === "infinite start") span.startTime = Infinity;
        if (invalid === "overflowing end") {
          span.startTime = Number.MAX_VALUE;
          span.duration = Number.MAX_VALUE;
        }
        assert.throws(() => check(f));
      });
}
test("Cost nonowner initialization cannot use a successful Runtime catalog", () => {
  const f = costControlTraceFixture({ catalog: true });
  check(f);
  f.expected.agentAccessDenied = true;
  assert.throws(() => check(f));
});
