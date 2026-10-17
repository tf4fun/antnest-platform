import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOwned, assertRestarted } from "./ownership.mjs";

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
  },
});

test("Restart requires the owned healthy ACP container", () => {
  assertOwned(row(), "antnest-stage3-e2e-123", "run");
  for (const modify of [
    (x) => (x.Config.Labels["com.docker.compose.project"] = "foreign"),
    (x) => (x.Config.Labels["com.docker.compose.service"] = "foreign"),
    (x) => (x.Config.Labels["io.antnest.e2e-run-id"] = "foreign"),
    (x) => (x.State.Running = false),
    (x) => (x.State.Health.Status = "unhealthy"),
    (x) => (x.State.OOMKilled = true),
  ]) {
    const bad = row();
    modify(bad);
    assert.throws(() => assertOwned(bad, "antnest-stage3-e2e-123", "run"));
  }
  assert.throws(() => assertOwned(row(), "antnest-dev-20260915", "run"));
  assert.throws(() => assertOwned(row(), "antnest-stage3-e2e-123", ""));
});

test("Restart requires the same container and labels with a new healthy process", () => {
  const before = row(),
    after = row();
  after.State.StartedAt = "after";
  assertRestarted(before, after);
  for (const modify of [
    (x) => (x.Id = "foreign"),
    (x) => x.RestartCount++,
    (x) => (x.Config.Labels["io.antnest.e2e-run-id"] = "foreign"),
    (x) => (x.State.Running = false),
    (x) => (x.State.Health.Status = "unhealthy"),
    (x) => (x.State.OOMKilled = true),
    (x) => (x.State.StartedAt = "before"),
  ]) {
    const bad = structuredClone(after);
    modify(bad);
    assert.throws(() => assertRestarted(before, bad));
  }
});
