import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as evidence from "./foundation-private-evidence.mjs";

test("runner merge retains reliability and both Workspace scenario dispatches", () => {
  const source = readFileSync(
    new URL("./foundation-run.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /profile === "reliability"\s*\?\s*\(await import\("\.\/reliability-flow\.mjs"\)\)\.runReliability/u,
  );
  assert.match(
    source,
    /profile === "workspace"\s*\?\s*\(\s*await import\("\.\.\/workspace-closeout\/current-flow\.mjs"\)\s*\)\.workspaceProtocol\s*:\s*profile === "workspace-browser"\s*\?\s*\(\s*await import\("\.\.\/workspace-closeout\/browser-current-flow\.mjs"\)\s*\)\.runBrowserProfile/u,
  );
});

test("runner merge retains main recovery profiles in auxiliary diagnostics", () => {
  const source = readFileSync(
    new URL("./foundation-run.mjs", import.meta.url),
    "utf8",
  );
  const definition = source.match(
    /const foundationDiagnostics = (\[[\s\S]*?\])\.includes\(profile\)/u,
  );
  assert(definition, "runner must explicitly select auxiliary diagnostic profiles");
  assert.deepEqual(
    [...definition[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
    ["foundation", "loss", "restore", "skill-restore", "shutdown"],
  );
});

test("runner merge retains both sides of the public business status profiles", () => {
  const source = readFileSync(
    new URL("./foundation-run.mjs", import.meta.url),
    "utf8",
  );
  const definition = source.match(
    /status:\s*(\[[\s\S]*?\])\.includes\(\s*profile,?\s*\)/u,
  );
  assert(definition, "runner must explicitly select public business profiles");
  assert.deepEqual(
    [...definition[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
    [
      "workspace",
      "foundation",
      "loss",
      "restore",
      "skill-restore",
      "shutdown",
      "reliability",
    ],
  );
});

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
    /profile === "foundation"\s*\? foundationPublicResult\(result\)\s*: profile === "health"\s*\? healthPublicResult\(result\)\s*: profile === "network"\s*\? networkPublicResult\(result\)\s*: profile === "loss"\s*\? lossPublicResult\(result\)\s*: profile === "restore"\s*\? restorePublicResult\(result\)\s*: profile === "skill-restore"\s*\? skillRestorePublicResult\(result\)\s*: profile === "shutdown"\s*\? shutdownPublicResult\(result\)\s*: profile === "workspace"\s*\? workspacePublicResult\(result\)\s*: result/u,
  );
  const archiveIndex = source.indexOf(
    'writeEvidenceFile(config.evidence, "business.json", JSON.stringify(result))',
  );
  assert(
    archiveIndex >= 0 &&
      archiveIndex <
        source.indexOf("admission = await admitFoundationBusiness(result, {"),
    "raw business evidence must survive a rejected admission",
  );
  const networkFailureIndex = source.indexOf(
    "networkFailures(result.networkErrors)",
  );
  const shutdownFailureIndex = source.indexOf(
    "shutdownFailures(result.shutdownErrors)",
  );
  const workspaceFailureIndex = source.indexOf(
    "workspaceFailures(result.workspaceErrors)",
  );
  assert(
    workspaceFailureIndex > archiveIndex &&
      workspaceFailureIndex <
        source.indexOf("admission = await admitWorkspaceBusiness(result, {"),
    "Workspace must archive original evidence and propagate failures before admission",
  );
  assert(
    shutdownFailureIndex > archiveIndex &&
      shutdownFailureIndex <
        source.indexOf("admission = shutdownPrivateAdmission(result)"),
    "Shutdown must preserve raw evidence before propagating original failures",
  );
  const lossFailureIndex = source.indexOf("lossFailures(result.lossErrors)");
  const restoreFailureIndex = source.indexOf(
    "restoreFailures(result.restoreErrors)",
  );
  assert(
    restoreFailureIndex > archiveIndex &&
      restoreFailureIndex <
        source.indexOf("admission = restorePrivateAdmission(result)"),
    "Restore must preserve raw evidence before propagating original failures",
  );
  assert(
    lossFailureIndex > archiveIndex &&
      lossFailureIndex <
        source.indexOf("admission = await admitLossBusiness(result, {"),
    "Loss must archive original business evidence before propagating collection/cleanup failures",
  );
  assert(
    networkFailureIndex > archiveIndex &&
      networkFailureIndex <
        source.indexOf("admission = networkPrivateAdmission(result)"),
    "Network preserves business receipts before propagating collection and cleanup failures",
  );
  assert.match(
    source,
    /"failure\.private\.txt",\s*inspect\(failure, \{ depth: 8 \}\)/u,
    "first failure receipt must contain the combined error even if the final rewrite fails",
  );
});
