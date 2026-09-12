import assert from "node:assert/strict";
import { queryHTTPTrace } from "./query.mjs";

const [base, traceID, rawConfig] = process.argv.slice(2);
assert(
  base && /^[a-f0-9]{32}$/u.test(traceID ?? "") && rawConfig,
  "usage: node scripts/observability/check-trace.mjs JAEGER_URL TRACE_ID CONFIG_JSON",
);
const config = JSON.parse(rawConfig);
console.log(
  JSON.stringify(await queryHTTPTrace(base, traceID, config), null, 2),
);
