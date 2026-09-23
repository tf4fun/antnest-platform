import assert from "node:assert/strict";
import test from "node:test";
import { assertSecretFree, inspectServiceLogs } from "./evidence.mjs";

const services = ["edge-gateway", "admin-console", "identity-service"];
const logs = services
  .map(
    (service) =>
      `${service}-1 | ${JSON.stringify({
        level: "INFO",
        trace_id: "a".repeat(32),
        msg: "request completed",
      })}`,
  )
  .join("\n");

test("log evidence requires correlated records from every participating service", () => {
  inspectServiceLogs(logs, ["synthetic-secret"], ["a".repeat(32)]);
  for (const incomplete of [
    "",
    "a startup line",
    logs.split("\n").slice(1).join("\n"),
  ]) {
    assert.throws(() =>
      inspectServiceLogs(incomplete, ["synthetic-secret"], ["a".repeat(32)]),
    );
  }
  assert.throws(() =>
    inspectServiceLogs(logs, ["synthetic-secret"], ["b".repeat(32)]),
  );
});

test("credential leakage fails without redisclosing raw or encoded canaries", () => {
  for (const canary of [
    "pkce-verifier-synthetic",
    "eyJhbGciOiJSUzI1NiJ9.synthetic.signature",
    Buffer.from("client:synthetic-secret").toString("base64"),
    "state/with+encoding",
  ]) {
    for (const encoded of [canary, encodeURIComponent(canary)]) {
      for (const inspect of [
        () => assertSecretFree(`trace: ${encoded}`, [canary]),
        () =>
          inspectServiceLogs(`${logs}\n${encoded}`, [canary], ["a".repeat(32)]),
      ]) {
        assert.throws(inspect, (error) => {
          assert(!String(error).includes(canary));
          assert(!String(error).includes(encoded));
          return true;
        });
      }
    }
  }
});
