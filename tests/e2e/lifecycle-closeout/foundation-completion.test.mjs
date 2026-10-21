import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, summary } from "./foundation-business-fixtures.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { foundationPublicResult } from "./foundation-private-evidence.mjs";

const url = new URL("./foundation-completion.mjs", import.meta.url);
const { admitFoundationBusiness: admit } = await import(url).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
    throw error;
  return {};
});
const requireAPI = () => assert.equal(typeof admit, "function");
function result() {
  const original = fixture();
  const kinds = [
    "create",
    "create",
    "delete",
    "rebuild",
    "disable",
    "enable",
    "delete",
    "create",
    "delete",
  ];
  const admissions = kinds.map((kind, index) => {
    const agentID = [1, 2].includes(index)
      ? "noise-agent"
      : index >= 7
        ? "failed-agent"
        : original.agent_id;
    const requestID = `operation-${index}`;
    return {
      kind,
      agentID,
      requestID,
      ...(index === 7 ? { runtimeStartupFailure: true } : {}),
      terminal: {
        kind,
        agent_id: agentID,
        request_id: requestID,
        state: "completed",
      },
    };
  });
  return {
    profile: "lifecycle-foundation-and-startup-failure",
    operations: 9,
    lifecycle_kinds: kinds,
    private_lifecycle_admissions: admissions,
    private_observations: [
      {
        event_id: "observed-event",
        agent_id: "failed-agent",
        business: "passed",
      },
    ],
    replay_observation_events: 1,
    traces: [],
    network_cas_changes: 2,
    workspace_preserved_and_removed: true,
    idle_restart_replay: true,
    failed_runtime_deleted_before_teardown: true,
    active_run_rebuild: {
      completed_prompts: 2,
      denied_prompts: 2,
      cleanup_completed: true,
      same_session_after_rebuild: true,
      physical_tool_effects_exact: true,
      controller_restart: {
        nonterminal_phase: "drain",
        graceful: true,
        exit_code: 0,
        process_restart_verified: true,
      },
      private_business: original,
      private_connections: original.private_connections,
      private_state_receipts: [
        {
          agentId: original.agent_id,
          method: "POST",
          status: 200,
          path: "/rpc/agent-acp/get-agent-execution-state",
          rawBody: JSON.stringify({
            agent_id: original.agent_id,
            access_allowed: true,
            configuration_revision: "a".repeat(64),
            availability: "busy",
            active_session_id: original.audits[0].session_id,
            unavailable_reason: "agent_unavailable",
          }),
        },
      ],
      run_ids: original.audits[0].all.map(({ run }) => run.run_id),
      run_traces: [],
    },
  };
}
async function diagnostics(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "foundation-completion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    traceDiagnostics: createTraceDiagnostics({ directory, ...options }),
  };
}

test("Foundation completes independent persisted business with missing Trace retained as a warning", async (t) => {
  requireAPI();
  const options = await diagnostics(t),
    original = result(),
    before = structuredClone(original);
  const completed = await admit(original, options);
  assert.equal(completed.accepted_exit, 0);
  assert.deepEqual(completed.business, {
    ...summary,
    lifecycle_admissions: 9,
    observation_events: 1,
  });
  assert.equal(completed.trace_diagnostics.role, "auxiliary");
  assert.equal(completed.trace_diagnostics.status, "warning");
  assert.notEqual(completed.strict_exit, 0);
  assert(
    (await readdir(options.directory)).some((name) =>
      name.endsWith(".private.txt"),
    ),
  );
  assert.deepEqual(original, before);
});

test("Foundation ignores exhausted Trace budget only after complete business validation", async (t) => {
  requireAPI();
  const options = await diagnostics(t, { budgetMs: 0 });
  const completed = await admit(result(), options);
  assert.equal(completed.accepted_exit, 0);
  assert.equal(completed.trace_diagnostics.status, "warning");
  const broken = result();
  broken.active_run_rebuild.private_business.audits[0].all[0].run.state =
    "running";
  await assert.rejects(admit(broken, options));
});

test("Foundation retains hard business and cleanup gates independently of diagnostic availability", async (t) => {
  requireAPI();
  const options = await diagnostics(t, { budgetMs: 0 });
  for (const mutate of [
    (r) => {
      delete r.active_run_rebuild.private_business;
    },
    (r) => {
      r.active_run_rebuild.cleanup_completed = false;
    },
    (r) => {
      r.active_run_rebuild.physical_tool_effects_exact = false;
    },
    (r) => {
      r.active_run_rebuild.controller_restart.process_restart_verified = false;
    },
    (r) => {
      r.active_run_rebuild.run_ids[1] = "foreign-run";
    },
    (r) => {
      r.workspace_preserved_and_removed = false;
    },
    (r) => {
      r.failed_runtime_deleted_before_teardown = false;
    },
    (r) => {
      r.network_cas_changes = 1;
    },
    (r) => {
      r.idle_restart_replay = false;
    },
  ]) {
    const original = result();
    mutate(original);
    await assert.rejects(admit(original, options));
  }
});

test("Foundation checks original scope and drain state receipts even when all Trace is missing", async (t) => {
  requireAPI();
  const options = await diagnostics(t, { budgetMs: 0 });
  for (const mutate of [
    (rows) => rows.splice(0),
    (rows) => {
      rows[0].status = 403;
    },
    (rows) => {
      rows[0].agentId = "foreign-agent";
    },
    (rows) => {
      rows[0].rawBody = JSON.stringify({
        ...JSON.parse(rows[0].rawBody),
        access_allowed: false,
      });
    },
    (rows) => {
      rows[0].rawBody = JSON.stringify({
        ...JSON.parse(rows[0].rawBody),
        active_session_id: "foreign-session",
      });
    },
    (rows) => {
      rows[0].rawBody = JSON.stringify({
        ...JSON.parse(rows[0].rawBody),
        unavailable_reason: null,
      });
    },
  ]) {
    const original = result();
    mutate(original.active_run_rebuild.private_state_receipts);
    await assert.rejects(admit(original, options));
  }
});

test("Foundation binds nine lifecycle outcomes and independent persisted observation receipts", async (t) => {
  requireAPI();
  const options = await diagnostics(t, { budgetMs: 0 });
  for (const mutate of [
    (r) => {
      r.private_lifecycle_admissions.pop();
    },
    (r) => {
      r.private_lifecycle_admissions[0].terminal.request_id =
        "foreign-operation";
    },
    (r) => {
      r.private_lifecycle_admissions[0].terminal.state = "running";
    },
    (r) => {
      r.private_lifecycle_admissions[7].runtimeStartupFailure = false;
    },
    (r) => {
      r.private_lifecycle_admissions[7].outcome = "runtime_start_failed";
      r.private_lifecycle_admissions[7].terminal.state = "failed";
    },
    (r) => {
      r.private_lifecycle_admissions[1].requestID =
        r.private_lifecycle_admissions[0].requestID;
    },
    (r) => {
      r.lifecycle_kinds[0] = "enable";
    },
    (r) => {
      r.private_observations[0].business = "failed";
    },
    (r) => {
      r.private_observations[0].agent_id = "foreign-agent";
    },
    (r) => {
      r.private_observations.push({ ...r.private_observations[0] });
      r.replay_observation_events++;
    },
  ]) {
    const original = result();
    mutate(original);
    await assert.rejects(admit(original, options));
  }
});

test("Foundation parent cancellation remains blocking even when diagnostic budget is exhausted", async (t) => {
  requireAPI();
  const owner = new AbortController(),
    reason = new Error("original owner cancellation");
  const options = await diagnostics(t, { signal: owner.signal, budgetMs: 0 });
  owner.abort(reason);
  await assert.rejects(admit(result(), options), (error) => error === reason);
});

test("Foundation public completion excludes newly retained business and lifecycle original records", () => {
  const original = result();
  original.active_run_rebuild.private_business.private_canary =
    "private-audit-canary";
  original.private_lifecycle_admissions[0].private_canary =
    "private-lifecycle-canary";
  const before = structuredClone(original),
    publicResult = foundationPublicResult(original);
  assert.deepEqual(original, before);
  assert(!Object.hasOwn(publicResult.active_run_rebuild, "private_business"));
  assert(!Object.hasOwn(publicResult, "private_lifecycle_admissions"));
  assert(!JSON.stringify(publicResult).includes("private-audit-canary"));
  assert(!JSON.stringify(publicResult).includes("private-lifecycle-canary"));
});
