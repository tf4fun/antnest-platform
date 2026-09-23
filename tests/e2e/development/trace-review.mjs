import {
  readDevelopmentConfiguration,
  writeDevelopmentJSON,
} from "../../support/development-configuration.mjs";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  inspectChatTrace,
  inspectChatTraceTopology,
} from "../workspace-closeout/chat-trace.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
const { config, settings, secrets } = readDevelopmentConfiguration(
  values.config,
  "trace-review",
);
process.umask(0o077);
mkdirSync(config.output, { recursive: true, mode: 0o700 });
const sessionId = config.sessionId;
const query = new URLSearchParams({
  service: "agent-acp-service",
  limit: "20",
  lookback: "1h",
  tags: JSON.stringify({
    "rpc.method": "session/prompt",
    "antnest.session.id": sessionId,
  }),
});
const response = await fetch(new URL(`/api/traces?${query}`, config.jaeger), {
  signal: AbortSignal.timeout(10000),
});
assert(response.ok);
const { data } = await response.json();
assert.equal(data.length, Number(config.expectedTraceCount));
assert(
  data.every((trace) => /^[a-f0-9]{32}$/u.test(trace.traceID)),
  "invalid Trace ID",
);
assert.equal(
  new Set(data.map((trace) => trace.traceID)).size,
  data.length,
  "duplicate Trace ID",
);
const result = [];
for (const trace of data) {
  const expected = {
    sessionId,
    secrets: [
      settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
      ...Object.entries(secrets)
        .filter(([key]) => /KEY|TOKEN|PASSWORD|SECRET/.test(key))
        .map(([, value]) => value),
    ],
  };
  const report = inspectChatTraceTopology(trace, expected);
  let strict = "passed";
  try {
    inspectChatTrace(trace, expected);
  } catch (error) {
    assert.equal(
      error.message.split("\n")[0],
      "Jaeger span warnings require review",
    );
    strict = "failed: Jaeger span warnings require review";
  }
  const warnings = [
    ...new Set([
      ...(trace.warnings ?? []),
      ...trace.spans.flatMap((span) => span.warnings ?? []),
    ]),
  ];
  assert(
    warnings.every((warning) =>
      warning.startsWith("clock skew adjustment disabled"),
    ),
  );
  const tree = traceTopology(trace);
  const anomalies = trace.spans.flatMap((span) => {
    const parent = tree.parent(span);
    if (!parent || !["client", "producer"].includes(tag(parent, "span.kind")))
      return [];
    const startDelta = span.startTime - parent.startTime;
    const endDelta =
      parent.startTime + parent.duration - (span.startTime + span.duration);
    if (startDelta >= 0 && endDelta >= 0) return [];
    return [
      {
        service: tree.service(span),
        operation: span.operationName,
        span: span.spanID,
        parent: parent.spanID,
        parent_service: tree.service(parent),
        start_delta_us: startDelta,
        end_delta_us: endDelta,
        child_start_us: span.startTime,
        parent_start_us: parent.startTime,
      },
    ];
  });
  result.push({
    ...report,
    diagnostics: undefined,
    strict,
    warning_messages: warnings,
    timestamp_anomalies: anomalies,
  });
}
assert(
  result.filter((item) => item.runtime_calls > 0).length >=
    Number(config.minRuntimeTraces),
);
writeDevelopmentJSON(config, `traces-${data.length}.json`, data);
writeDevelopmentJSON(config, `trace-review-${data.length}.json`, result);
console.log(JSON.stringify(result));
