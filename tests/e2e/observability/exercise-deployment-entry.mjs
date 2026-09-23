import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { collectTrace } from "./collect.mjs";
import { inspectDeploymentEntry } from "./deployment-entry.mjs";

const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
  },
});

for (const path of ["/status", "/"]) {
  const response = await fetch(new URL(path, values.gateway), {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `entry ${path} HTTP status`);
  const id = response.headers.get("x-antnest-trace-id");
  assert.match(id ?? "", /^[a-f0-9]{32}$/u, "missing response trace identity");
  const body = await response.text();
  if (path === "/status") assert.equal(JSON.parse(body).status, "ready");
  else {
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/iu);
    assert.match(body, /<html\b/iu);
  }
  const result = await collectTrace(values.jaeger, id, (trace) =>
    inspectDeploymentEntry(trace, path),
  );
  console.log(
    JSON.stringify(
      {
        scenario: "BF-OPS-02",
        ...result,
        url: `${values.jaeger.replace(/\/$/u, "")}/trace/${id}`,
      },
      null,
      2,
    ),
  );
}
