import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOwned, assertStopped, assertRestarted } from "./process.mjs";
const row = () => ({
  Id: "a".repeat(64),
  RestartCount: 0,
  Config: {
    Labels: {
      "com.docker.compose.project": "antnest-stage3-e2e-123",
      "com.docker.compose.service": "agent-acp-service",
      "io.antnest.e2e-run-id": "run",
    },
  },
  State: {
    Running: true,
    StartedAt: "before",
    Health: { Status: "healthy" },
    OOMKilled: false,
    ExitCode: 0,
  },
});
test("fault observer requires natural exit 1 and same owned container with a new healthy process", () => {
  const a = row(),
    b = structuredClone(a),
    c = structuredClone(a);
  b.State.Running = false;
  b.State.ExitCode = 1;
  c.State.StartedAt = "after";
  assertOwned(a, "antnest-stage3-e2e-123", "run");
  assertStopped(a, b);
  assertRestarted(a, c);
  for (const modify of [
    (x) => (x.State.ExitCode = 137),
    (x) => (x.State.OOMKilled = true),
    (x) => x.RestartCount++,
    (x) => (x.Id = "foreign"),
    (x) => (x.State.Running = true),
  ]) {
    const bad = structuredClone(b);
    modify(bad);
    assert.throws(() => assertStopped(a, bad));
  }
  assert.throws(() => assertOwned(a, "antnest-dev-20260915", "run"));
  assert.throws(() => assertRestarted(a, a));
});
