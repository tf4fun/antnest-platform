import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verdict } from "../../support/ci-shard.mjs";
import { stage3BusinessFixture } from "./business-completion.fixture.mjs";

const url = new URL("./completion.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const complete = (input, options) => {
  assert.equal(typeof implementation.completeStage3, "function");
  return implementation.completeStage3(input, options);
};
const profile = (env) => {
  assert.equal(typeof implementation.stage3CompletionProfile, "function");
  return implementation.stage3CompletionProfile(env);
};
const clock =
  "clock skew adjustment disabled; not applying calculated delta of -2ms";
function fixture(status = 2) {
  const kinds = ["create", "disable", "enable", "rebuild", "delete"];
  const id = (n) => n.toString(16).padStart(32, "0");
  const requests = ["websocket", "http"].map((transport, index) => ({
    agentId: "agent",
    label: "same-label",
    kind: "ordinary",
    method: "session/prompt",
    requestId: 1,
    sessionId: "session-" + index,
    transport,
    traceID: id(index + 10),
    connectionTraceID: id(index + 20),
  }));
  const sessionTraces = requests.map((request) => ({
    trace_id: request.traceID,
    source_trace_ids: [request.traceID, request.connectionTraceID],
    label: request.label,
    kind: request.kind,
    method: request.method,
    request_id: request.requestId,
    session_id: request.sessionId,
    transport: request.transport,
    diagnostic_inventory_verified: true,
    strict_trace: status === 2 ? "failed" : "passed",
    warnings: status === 2 ? [clock] : [],
    warning_count: status === 2 ? 1 : 0,
  }));
  return {
    business: {
      status: "business_passed",
      agent_id: "agent",
      deleted: true,
      lifecycle_kinds: kinds,
      model_requests: 2,
    },
    report: {
      status: "topology_passed",
      strict_trace: status === 2 ? "failed" : "passed",
      lifecycle_diagnostics_accepted: true,
      private_acp: { accepted: true, exit_code: status },
      lifecycle_traces: kinds.map((kind, index) => ({
        trace_id: id(index + 1),
        agent_id: "agent",
        kind,
        strict_trace: "passed",
      })),
      session_traces: sessionTraces,
      logout_traces: [1, 2].map((version) => ({
        trace_id: id(version + 30),
        protocol_version: version,
        reason: "revoked",
        authorizationCauseVerified: true,
        owning_admission: "passed",
        strict_trace: "passed",
        denial: { status: 401, no_execution: true },
      })),
    },
    inventory: { requests, provider_requests: [{}, {}] },
    cleanup: {
      entry_status: status,
      client_status: status,
      archive_status: 0,
      cleanup_status: 0,
    },
  };
}

test("Stage3 completion preserves the exact diagnostic reports and exit 2", () => {
  const input = fixture(),
    original = structuredClone(input);
  const result = complete(input, { status: 2, profile: "base" });
  assert.equal(result.status, "business_and_topology_passed");
  assert.equal(result.cleanup, "verified");
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.strict_exit, 2);
  assert.equal(result.accepted_exit, 2);
  assert.deepEqual(result.traces, [
    ...input.report.lifecycle_traces,
    ...input.report.session_traces,
    ...input.report.logout_traces,
  ]);
  assert.deepEqual(input, original);
  assert.equal(verdict(2, JSON.stringify(result), true), "warning");
  assert.equal(verdict(1, JSON.stringify(result), true), "failed");
  result.traces[0].warnings = ["unknown diagnostic"];
  assert.equal(verdict(2, JSON.stringify(result), true), "warning");
});

test("Stage3 without strict findings retains successful exit 0", () => {
  const result = complete(fixture(0), { status: 0, profile: "base" });
  assert.equal(result.strict_trace, "passed");
  assert.equal(result.accepted_exit, 0);
});

for (const [name, change] of [
  ["business failure", (f) => (f.business.status = "business_failed")],
  ["undeleted Agent", (f) => (f.business.deleted = false)],
  ["missing topology", (f) => delete f.report],
  [
    "unaccepted lifecycle",
    (f) => (f.report.lifecycle_diagnostics_accepted = false),
  ],
  [
    "unaccepted private diagnostics",
    (f) => (f.report.private_acp.accepted = false),
  ],
  [
    "unverified private inventory",
    (f) => (f.report.session_traces[0].diagnostic_inventory_verified = false),
  ],
  [
    "foreign lifecycle",
    (f) => (f.report.lifecycle_traces[0].agent_id = "other"),
  ],
  ["missing lifecycle", (f) => f.report.lifecycle_traces.pop()],
  ["foreign private Agent", (f) => (f.inventory.requests[0].agentId = "other")],
  ["missing private request", (f) => f.inventory.requests.pop()],
  ["mixed request order", (f) => f.report.session_traces.reverse()],
  ["foreign wire ID", (f) => f.report.session_traces[0].request_id++],
  [
    "foreign HTTP Trace",
    (f) => (f.inventory.requests[1].traceID = "f".repeat(32)),
  ],
  [
    "foreign WS connection",
    (f) => (f.inventory.requests[0].connectionTraceID = "f".repeat(32)),
  ],
  ["missing model request", (f) => f.inventory.provider_requests.pop()],
  ["missing logout", (f) => f.report.logout_traces.pop()],
  [
    "unverified logout",
    (f) => (f.report.logout_traces[0].authorizationCauseVerified = false),
  ],
  [
    "logout created work",
    (f) => (f.report.logout_traces[0].denial.no_execution = false),
  ],
  ["client failure", (f) => (f.cleanup.client_status = 1)],
  ["inner runner failure", (f) => (f.cleanup.entry_status = 1)],
  ["archive failure", (f) => (f.cleanup.archive_status = 1)],
  ["inner cleanup failure", (f) => (f.cleanup.cleanup_status = 1)],
]) {
  test("Stage3 completion rejects " + name, () => {
    assert.equal(typeof implementation.completeStage3, "function");
    const input = fixture();
    change(input);
    assert.throws(() => complete(input, { status: 2, profile: "base" }));
  });
}
test("a failed outer runner cannot publish completion from valid old reports", () => {
  assert.equal(typeof implementation.completeStage3, "function");
  assert.throws(() => complete(fixture(), { status: 1, profile: "base" }));
});

for (const [flag, expected, key, value] of [
  [null, "skill-delivery", null, null],
  [
    "REGISTRY_OUTAGE",
    "registry-outage",
    "registry_outage",
    "registry_outage_recovered",
  ],
  [
    "OFFLINE_REUSE",
    "offline-reuse",
    "offline_skill_reuse",
    "offline_skill_reuse_passed",
  ],
  [
    "RESTART_REBUILD",
    "restart-rebuild",
    "fenced_rebuild_restart",
    "fenced_rebuild_restart_recovered",
  ],
]) {
  test("Stage3 finalizes the original " + expected + " profile", () => {
    const env = { ANTNEST_E2E_SKILL_DELIVERY: "true" };
    if (flag) env["ANTNEST_E2E_SKILL_" + flag] = "true";
    assert.equal(profile(env), expected);
    const input = fixture();
    input.business.immutable_skill_versions = [1, 2];
    input.business.registry_network_denial = {
      service_name: true,
      actual_ipv4_via_antnest0: true,
    };
    if (key) input.business[key] = { status: value };
    if (expected === "offline-reuse") {
      input.business.lifecycle_kinds.splice(4, 0, "rebuild");
      input.report.lifecycle_traces.splice(4, 0, {
        ...input.report.lifecycle_traces[3],
        trace_id: "f".repeat(32),
      });
    }
    assert.equal(
      complete(input, { status: 2, profile: expected }).accepted_exit,
      2,
    );
    if (expected === "offline-reuse") {
      const missing = structuredClone(input);
      missing.report.lifecycle_traces.splice(4, 1);
      assert.throws(() => complete(missing, { status: 2, profile: expected }));
    }
    if (key) delete input.business[key];
    else delete input.business.immutable_skill_versions;
    assert.throws(() => complete(input, { status: 2, profile: expected }));
  });
}

test("Stage3 completion selection excludes independent fault profiles", () => {
  assert.equal(profile({}), "base");
  for (const flag of [
    "SKILL_READY_LOSS",
    "SKILL_READY_DRIFT",
    "SKILL_TARGET_DRIFT",
    "SKILL_MOUNT_RACE",
    "SKILL_INITIALIZE_RACE",
    "SKILL_MOUNT_RESPONSE_LOSS",
    "SKILL_START_RESPONSE_LOSS",
    "SKILL_FENCED_INVALIDATION",
    "LEGACY_INVENTORY",
  ])
    assert.equal(
      profile({
        ANTNEST_E2E_SKILL_DELIVERY: "true",
        ["ANTNEST_E2E_" + flag]: "true",
      }),
      null,
    );
  assert.equal(profile({ ANTNEST_E2E_SKILL_OFFLINE_REUSE: "true" }), null);
  assert.equal(
    profile({
      ANTNEST_E2E_SKILL_DELIVERY: "true",
      ANTNEST_E2E_SKILL_OFFLINE_REUSE: "true",
      ANTNEST_E2E_SKILL_REGISTRY_OUTAGE: "true",
    }),
    null,
  );
});

for (const failure of [
  "none",
  "outer",
  "trace-exit",
  "missing-report",
  "missing-logouts",
  "write",
]) {
  test(
    "Stage3 completion CLI preserves private evidence: " + failure,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "stage3-finalizer-"));
      try {
        const project = "antnest-stage3-e2e-1";
        const evidence = join(
          directory,
          "artifacts/verification/stage3-base",
          project,
        );
        await mkdir(evidence, { recursive: true, mode: 0o700 });
        const input = stage3BusinessFixture("base");
        input.report = { status: "collection_failed", strict_trace: "failed" };
        const originals = new Map();
        for (const [key, name] of [
          ["business", "business.json"],
          ["report", "report.json"],
          ["inventory", "private-inventory.json"],
          ["logouts", "logout-observations.json"],
          ["cleanup", "cleanup.json"],
        ]) {
          if (failure === "missing-report" && key === "report") continue;
          if (failure === "missing-logouts" && key === "logouts") continue;
          const data = JSON.stringify(input[key]);
          originals.set(name, data);
          await writeFile(join(evidence, name), data, { mode: 0o600 });
        }
        if (failure === "write") await mkdir(join(evidence, "completion.json"));
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(url),
            project,
            failure === "outer" ? "1" : failure === "trace-exit" ? "2" : "0",
          ],
          {
            cwd: directory,
            encoding: "utf8",
            timeout: 5000,
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith("ANTNEST_E2E_"),
              ),
            ),
          },
        );
        assert.ifError(result.error);
        const accepted = ["none", "missing-report"].includes(failure);
        assert.equal(result.status, accepted ? 0 : 1, result.stderr);
        if (accepted) {
          const report = JSON.parse(result.stdout);
          assert.equal(report.status, "business_passed");
          assert.equal(report.policy_revision, 1);
          assert.equal(verdict(0, result.stdout, true), "passed");
          assert.deepEqual(
            JSON.parse(
              await readFile(join(evidence, "completion.json"), "utf8"),
            ),
            report,
          );
          assert.equal(
            (await stat(join(evidence, "completion.json"))).mode & 0o777,
            0o600,
          );
        } else
          assert.doesNotMatch(result.stdout, /"status":"business_passed"/u);
        for (const [name, data] of originals)
          assert.equal(await readFile(join(evidence, name), "utf8"), data);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
