import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("stage2 e2e leaves the ACP PostgreSQL suite to its own CI shard", () => {
  const script = readFileSync(`${root}tests/e2e/e2e-stage2.sh`, "utf8");
  assert(
    !script.includes("stage2_acp_test"),
    "stage2 must not recreate the ACP PostgreSQL fixture",
  );
  assert(
    !script.includes("test:postgres"),
    "stage2 must not rerun the ACP PostgreSQL component suite",
  );
  assert(
    script.includes("stage2-boundary-flow"),
    "stage2 keeps the boundary flow check",
  );
  assert(
    script.includes("stage2_workflow_test"),
    "stage2 keeps the isolated worker recovery database",
  );
  assert(
    script.includes("TestTemporal"),
    "stage2 keeps the Temporal worker recovery checks",
  );
});
