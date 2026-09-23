import {
  readDevelopmentConfiguration,
  writeDevelopmentJSON,
} from "../../support/development-configuration.mjs";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
const { config } = readDevelopmentConfiguration(
  values.config,
  "rejection-trace",
);
process.umask(0o077);
mkdirSync(config.output, { recursive: true, mode: 0o700 });
const report = {
  rejected_session_id: config.rejectedSessionId,
};
const query = new URLSearchParams({
  service: "agent-acp-service",
  limit: "10",
  lookback: "1h",
  tags: JSON.stringify({
    "rpc.method": "session/prompt",
    "antnest.session.id": report.rejected_session_id,
  }),
});
const response = await fetch(new URL(`/api/traces?${query}`, config.jaeger), {
  signal: AbortSignal.timeout(10000),
});
assert(response.ok);
const { data } = await response.json();
assert.equal(data.length, 1);
const trace = data[0];
assert(/^[a-f0-9]{32}$/u.test(trace.traceID), "invalid Trace ID");
const tree = traceTopology(trace);
const prompts = trace.spans.filter(
  (span) =>
    tree.service(span) === "agent-acp-service" &&
    tag(span, "rpc.method") === "session/prompt" &&
    tag(span, "span.kind") === "server",
);
assert.equal(prompts.length, 1, "missing or duplicate ACP prompt");
assert.equal(
  tag(prompts[0], "antnest.session.id"),
  report.rejected_session_id,
  "rejection Session mismatch",
);
assertCaptureDisabled(trace);
const model = trace.spans.filter(
  (span) => span.operationName === "HTTP POST model",
);
const tools = trace.spans.filter(
  (span) =>
    tree.service(span) === "antnest-runtime" &&
    tag(span, "rpc.method") === "tools/call",
);
assert.equal(model.length, 0);
assert.equal(tools.length, 0);
assert(JSON.stringify(trace).includes("model_unsupported_content"));
const result = {
  trace_id: trace.traceID,
  session_id: report.rejected_session_id,
  model_requests: 0,
  runtime_tool_calls: 0,
  error_class: "model_unsupported_content",
  topology: "passed",
  capture: "disabled",
  scope: "expected rejection; not a successful-chat trace",
};
writeDevelopmentJSON(config, "rejection-trace.json", trace);
writeDevelopmentJSON(config, "rejection-trace-review.json", result);
console.log(JSON.stringify(result));
