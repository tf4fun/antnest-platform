import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const timeout = () => AbortSignal.timeout(3000);
const ingress = `http://${process.env.ANTNEST_PROBE_OTLP}:4318`;
for (const target of [
  `http://${process.env.ANTNEST_PROBE_RC}:8080/status`,
  `http://${process.env.ANTNEST_PROBE_ACP}:8080/status`,
  `http://${process.env.ANTNEST_PROBE_OTLP}:16686/api/services`,
]) {
  await assert.rejects(
    fetch(target, { signal: timeout(), redirect: "manual" }),
  );
}
assert.equal(
  (
    await fetch(`${ingress}/api/services`, {
      signal: timeout(),
      redirect: "manual",
    })
  ).status,
  404,
);
const traceId = randomBytes(16).toString("hex"),
  spanId = randomBytes(8).toString("hex");
const start = BigInt(Date.now()) * 1000000n;
const response = await fetch(`${ingress}/v1/traces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  signal: timeout(),
  redirect: "manual",
  body: JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "deployment-admission-probe" },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "actual-compose-admission" },
            spans: [
              {
                traceId,
                spanId,
                name: "deployment.otlp.ingest",
                kind: 1,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(start + 1000000n),
              },
            ],
          },
        ],
      },
    ],
  }),
});
assert.equal(response.status, 200);
await response.arrayBuffer();
console.log(JSON.stringify({ checks: 5, trace_id: traceId }));
