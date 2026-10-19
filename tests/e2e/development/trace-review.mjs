import {
  readDevelopmentConfiguration,
  writeDevelopmentJSON,
} from "../../support/development-configuration.mjs";
import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { reviewDevelopmentChatTrace } from "./chat-trace.mjs";

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
const data = await searchJaegerTraces(config.jaeger, query, {
  signal: AbortSignal.timeout(10000),
});
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
  result.push(reviewDevelopmentChatTrace(trace, expected));
}
assert(
  result.filter((item) => item.runtime_calls > 0).length >=
    Number(config.minRuntimeTraces),
);
writeDevelopmentJSON(config, `traces-${data.length}.json`, data);
writeDevelopmentJSON(config, `trace-review-${data.length}.json`, result);
console.log(JSON.stringify(result));
