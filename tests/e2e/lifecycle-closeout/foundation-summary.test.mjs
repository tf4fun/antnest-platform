import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as evidence from "./foundation-private-evidence.mjs";

test("Foundation public summary excludes original RPC and state bodies without changing private admission evidence", () => {
  assert.equal(typeof evidence.foundationPublicResult, "function");
  const original = {
    profile: "lifecycle-foundation-and-startup-failure",
    operations: 9,
    active_run_rebuild: {
      completed_prompts: 2,
      cleanup_completed: true,
      private_connections: [
        {
          raw_frames: [{ result: { text: "private-tool-canary" } }],
          evidence: [{ requestParams: { text: "private-prompt-canary" } }],
        },
      ],
      private_state_receipts: [{ rawBody: "private-state-canary" }],
      run_traces: [
        {
          method: "initialize",
          request_id: "original-request",
          topology: "passed",
        },
      ],
    },
  };
  const before = structuredClone(original);
  const result = evidence.foundationPublicResult(original);
  assert.deepEqual(original, before);
  assert.notEqual(result, original);
  assert.notEqual(result.active_run_rebuild, original.active_run_rebuild);
  assert.equal(result.active_run_rebuild.completed_prompts, 2);
  assert.equal(result.active_run_rebuild.cleanup_completed, true);
  assert.deepEqual(
    result.active_run_rebuild.run_traces,
    original.active_run_rebuild.run_traces,
  );
  for (const secret of [
    "private-tool-canary",
    "private-prompt-canary",
    "private-state-canary",
  ])
    assert(!JSON.stringify(result).includes(secret));
  const source = readFileSync(
    new URL("./foundation-run.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /profile === "foundation"\s*\? foundationPublicResult\(result\)\s*: result/u,
  );
  const archiveIndex = source.indexOf(
    'writeEvidenceFile(config.evidence, "business.json", JSON.stringify(result))',
  );
  assert(
    archiveIndex >= 0 &&
      archiveIndex <
        source.indexOf("admission = foundationPrivateAdmission(result)"),
    "raw business evidence must survive a rejected admission",
  );
});
