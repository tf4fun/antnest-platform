import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { assertMaintenanceKidStartupRejected } from "./maintenance-kid.mjs";

const stopped = (component, errorClass) =>
  JSON.stringify({
    level: "ERROR",
    msg: "Runtime Controller stopped",
    component,
    error_class: errorClass,
    error: "redacted diagnostic",
  });

test("maintenance kid probe accepts structured configuration rejection without raw diagnostics", async () => {
  const result = await assertMaintenanceKidStartupRejected({
    image: "fixture",
    project: "fixture",
    docker: async (args) => {
      execFileSync("/bin/sh", ["-n", "-c", args.at(-1)], { timeout: 1000 });
      return stopped("configuration", "invalid_configuration");
    },
  });
  assert.deepEqual(result, { kid: "release.2026", rejected_at_startup: true });
});

for (const [component, errorClass] of [
  ["repository", "database_connection_failed"],
  ["telemetry", "telemetry_setup_failed"],
]) {
  test(
    "maintenance kid probe rejects an unrelated " +
      component +
      " startup failure",
    async () => {
      await assert.rejects(
        assertMaintenanceKidStartupRejected({
          image: "fixture",
          project: "fixture",
          docker: async () => stopped(component, errorClass),
        }),
      );
    },
  );
}
