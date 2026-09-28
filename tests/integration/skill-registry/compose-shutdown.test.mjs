import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("Compose allows RC to settle interrupted Skill preparation before forced stop", () => {
  const output = execFileSync(
    "docker",
    ["compose", "--profile", "stage3", "config", "--format", "json"],
    { cwd: root, encoding: "utf8" },
  );
  const service = JSON.parse(output).services["runtime-controller"];
  assert.match(service.stop_grace_period, /^\d+s$/);
  assert.ok(
    Number.parseInt(service.stop_grace_period, 10) >= 30,
    "RC shutdown has a 10-second HTTP wait and a 12-second Skill worker wait",
  );
});
