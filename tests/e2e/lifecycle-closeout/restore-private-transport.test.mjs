import assert from "node:assert/strict";
import test from "node:test";
import { restoreTransportFixture } from "./restore-private-transport.fixture.mjs";
const url = new URL("./restore-private-transport.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
test("Restore proves the private relay, exporter receiver and Jaeger survived storage replacement", async () => {
  assert.equal(typeof implementation.readRestoreTransport, "function");
  const f = restoreTransportFixture(),
    calls = [];
  const config = {
    project: f.project,
    privateAccess: f.privateAccess,
    jaeger: f.jaeger,
    compose: (args) => ["compose", ...args],
  };
  const docker = async (args) => {
    calls.push(args);
    return args[0] === "inspect"
      ? JSON.stringify(f.rows)
      : f.rows.map((r) => r.Id).join("\n");
  };
  const before = await implementation.readRestoreTransport(config, docker);
  const after = await implementation.readRestoreTransport(config, docker);
  implementation.assertRestoreTransportContinuity(before, after);
  assert.deepEqual(calls[0], [
    "compose",
    "ps",
    "-q",
    "diagnostic-relay",
    "foundation-client-telemetry",
    "jaeger",
  ]);
  assert.deepEqual(calls[1], ["inspect", ...f.rows.map((r) => r.Id)]);
  assert.deepEqual(before.rows, f.rows);
  for (const mutate of [
    (v) => {
      v.rows[0].Id = "replacement";
    },
    (v) => {
      v.rows[1].State.StartedAt = "2026-10-19T00:00:01Z";
    },
    (v) => {
      v.rows[2].RestartCount = 1;
    },
    (v) => {
      v.rows[0].NetworkSettings.Ports["58081/tcp"][0].HostPort = "46002";
    },
    (v) => {
      v.rows[1].State.Running = false;
    },
    (v) => {
      v.rows[0].Config.Labels["com.docker.compose.project"] = "foreign";
    },
    (v) => {
      v.rows.push(structuredClone(v.rows[0]));
    },
    (v) => {
      v.privateAccess.acp = "http://127.0.0.1:46002";
    },
  ]) {
    const changed = structuredClone(after);
    mutate(changed);
    assert.throws(() =>
      implementation.assertRestoreTransportContinuity(before, changed),
    );
  }
});
