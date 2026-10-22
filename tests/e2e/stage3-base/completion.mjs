import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
import { completeStage3Business } from "./business-completion.mjs";

const recoveries = {
  "registry-outage": ["registry_outage", "registry_outage_recovered"],
  "offline-reuse": ["offline_skill_reuse", "offline_skill_reuse_passed"],
  "restart-rebuild": [
    "fenced_rebuild_restart",
    "fenced_rebuild_restart_recovered",
  ],
};

export function stage3CompletionProfile(env = process.env) {
  const enabled = (flag) => env["ANTNEST_E2E_" + flag] === "true";
  if (
    [
      "SKILL_READY_LOSS",
      "SKILL_READY_DRIFT",
      "SKILL_TARGET_DRIFT",
      "SKILL_MOUNT_RACE",
      "SKILL_INITIALIZE_RACE",
      "SKILL_MOUNT_RESPONSE_LOSS",
      "SKILL_START_RESPONSE_LOSS",
      "SKILL_FENCED_INVALIDATION",
      "LEGACY_INVENTORY",
    ].some(enabled)
  )
    return null;
  const selected = [
    ["SKILL_REGISTRY_OUTAGE", "registry-outage"],
    ["SKILL_OFFLINE_REUSE", "offline-reuse"],
    ["SKILL_RESTART_REBUILD", "restart-rebuild"],
  ].filter(([flag]) => enabled(flag));
  if (selected.length > 1 || (selected.length && !enabled("SKILL_DELIVERY")))
    return null;
  return (
    selected[0]?.[1] ?? (enabled("SKILL_DELIVERY") ? "skill-delivery" : "base")
  );
}

// Summarize already verified collector results after the outer runner has
// joined its work and checked both Docker ownership labels. This does not
// reinterpret raw errors or turn incomplete inner cleanup into completion.
export function completeStage3(
  { business, report, inventory, cleanup },
  { status, profile },
) {
  assert([0, 2].includes(status), "outer runner did not complete");
  assert(
    ["base", "skill-delivery", ...Object.keys(recoveries)].includes(profile),
  );
  assert.equal(cleanup.entry_status, status, "inner runner failed");
  assert.equal(cleanup.client_status, status, "client did not complete");
  assert.equal(cleanup.archive_status, 0, "evidence archive failed");
  assert.equal(cleanup.cleanup_status, 0, "inner cleanup failed");
  assert.equal(business.status, "business_passed");
  assert.equal(business.deleted, true);
  assert(typeof business.agent_id === "string" && business.agent_id);
  assert.equal(report.status, "topology_passed");
  assert.equal(report.lifecycle_diagnostics_accepted, true);
  assert.equal(report.private_acp.accepted, true);
  assert([0, 2].includes(report.private_acp.exit_code));
  const {
    lifecycle_traces: lifecycle,
    session_traces: sessions,
    logout_traces: logouts,
  } = report;
  for (const rows of [
    lifecycle,
    sessions,
    logouts,
    inventory.requests,
    inventory.provider_requests,
  ])
    assert(
      Array.isArray(rows) && rows.length > 0,
      "missing original inventory",
    );
  assert.deepEqual(
    lifecycle.map((row) => row.kind),
    business.lifecycle_kinds,
  );
  assert(
    lifecycle.every((row) => row.agent_id === business.agent_id),
    "foreign lifecycle Agent",
  );
  assert.equal(sessions.length, inventory.requests.length);
  assert.equal(
    new Set(sessions.map((row) => row.trace_id)).size,
    sessions.length,
  );
  for (const [index, row] of sessions.entries()) {
    const request = inventory.requests[index];
    assert.equal(request.agentId, business.agent_id, "foreign private Agent");
    assert.equal(row.diagnostic_inventory_verified, true);
    for (const [source, target] of [
      ["label", "label"],
      ["kind", "kind"],
      ["method", "method"],
      ["requestId", "request_id"],
      ["transport", "transport"],
    ]) {
      assert.notEqual(
        request[source],
        undefined,
        "missing original request field",
      );
      assert.deepEqual(
        row[target],
        request[source],
        "different private request",
      );
    }
    assert.equal(row.session_id ?? null, request.sessionId ?? null);
    if (request.transport === "http")
      assert.equal(row.trace_id, request.traceID, "foreign HTTP Trace");
    else {
      assert.equal(request.transport, "websocket");
      assert(
        row.source_trace_ids?.includes(request.connectionTraceID),
        "foreign WS connection",
      );
    }
  }
  assert.equal(inventory.provider_requests.length, business.model_requests);
  assert.deepEqual(
    logouts.map((row) => row.protocol_version),
    [1, 2],
  );
  for (const row of logouts) {
    assert.equal(row.reason, "revoked");
    assert.equal(row.owning_admission, "passed");
    assert.equal(row.authorizationCauseVerified, true);
    assert.equal(row.denial.status, 401);
    assert.equal(row.denial.no_execution, true);
  }
  if (profile !== "base") {
    assert.deepEqual(business.immutable_skill_versions, [1, 2]);
    assert.equal(business.registry_network_denial?.service_name, true);
    assert.equal(
      business.registry_network_denial?.actual_ipv4_via_antnest0,
      true,
    );
    if (recoveries[profile]) {
      const [field, expected] = recoveries[profile];
      assert.equal(business[field]?.status, expected, "missing Skill recovery");
    }
  }
  const traces = [...lifecycle, ...sessions, ...logouts];
  for (const row of traces) {
    assert.match(row.trace_id, /^[a-f0-9]{32}$/u);
    assert(["passed", "failed"].includes(row.strict_trace));
  }
  assert.equal(
    report.strict_trace,
    traces.some((row) => row.strict_trace === "failed") ? "failed" : "passed",
  );
  if (
    report.private_acp.exit_code === 2 ||
    logouts.some((row) => row.strict_trace === "failed")
  )
    assert.equal(status, 2, "raw strict exit was lost");
  if (status === 2) assert.equal(report.strict_trace, "failed");
  return {
    status: "business_and_topology_passed",
    suite: "stage3-" + profile,
    agent_id: business.agent_id,
    cleanup: "verified",
    strict_trace: report.strict_trace,
    strict_exit: status,
    accepted_exit: status,
    traces,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const profile = stage3CompletionProfile();
    if (profile) {
      const [project, entryStatus] = process.argv.slice(2);
      assert.match(project, /^antnest-stage3-e2e-[0-9]+$/u);
      const directory = evidenceDirectory(
        "artifacts/verification/stage3-base/" + project,
      );
      const read = (name) =>
        JSON.parse(readFileSync(evidenceFilePath(directory, name), "utf8"));
      const result = completeStage3Business(
        {
          business: read("business.json"),
          inventory: read("private-inventory.json"),
          logouts: read("logout-observations.json"),
          cleanup: read("cleanup.json"),
        },
        { status: Number(entryStatus), profile },
      );
      writeEvidenceFile(
        directory,
        "completion.json",
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(asciiJSON(result));
    }
  } catch (error) {
    console.error("Stage3 completion failed: " + error.message);
    process.exitCode = 1;
  }
}
