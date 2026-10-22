import assert from "node:assert/strict";
import { inspect } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertCompletedExecution } from "./foundation-evidence.mjs";
import { isBusyDenied } from "../managed-mcp/drain.mjs";
import { assertReplay } from "../../integration/agent-acp-service/support/persistence/evidence.mjs";
import { assertCatalog } from "../acp-commands/evidence.mjs";
import { until } from "../acp-closeout/wait.mjs";
import {
  assertDrain,
  assertControllerStopped,
  heldProcessCommand,
} from "./drain-evidence.mjs";
import { lines } from "./docker.mjs";
import { createFoundationPrivateAccess } from "./foundation-private-access.mjs";
import { collectFoundationRequests } from "./foundation-private-trace.mjs";
import { collectFoundationBusinessEvidence } from "./foundation-business-collection.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";

export async function withHeldRun({
  config,
  docker,
  json,
  resources,
  command,
  agentID,
  initial,
  template,
  ready,
  signal,
  traceDiagnostics,
}) {
  const owner = new GatewayClient(config.gateway);
  const login = await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  const principal = login.body.principal;
  const secrets = [
    "stage3-model-secret",
    "lifecycle-owner-password",
    ...owner.cookies.values(),
  ];
  const access = await createFoundationPrivateAccess(config, {
    signal,
    secrets,
    traceDiagnostics,
  });
  let client, prompt, pid, output;
  let settled = false;
  const errors = [];
  const originalReads = [],
    modelStates = [];
  let businessEvidence = {
    agent_id: agentID,
    principal_id: principal.user_id,
    private_connections: [],
    execution_revisions: {
      "c3-held-run": initial.agent.executable_execution_revision,
    },
    busy_checks: [],
    provider_requests: [],
    audits: [],
  };
  const readAudit = async (path) => {
    const body = await json(path);
    originalReads.push({ path, body });
    return body;
  };
  const auditPage = async (sessionId) => {
    const value = await readAudit(
      `/api/admin/execution-audits?agent_id=${encodeURIComponent(agentID)}&session_id=${encodeURIComponent(sessionId)}&limit=100`,
    );
    assert.equal(value.next_cursor, null);
    return value;
  };
  const audits = async (sessionId) => {
    const value = await auditPage(sessionId);
    return value.items;
  };
  const saved = async (id) => {
    const run = await readAudit(`/api/admin/execution-audits/${id}`);
    const events = await readAudit(
      `/api/admin/execution-audits/${id}/events?limit=100`,
    );
    assert.equal(events.next_cursor, null, "Run event evidence is truncated");
    return { run, events };
  };
  const modelState = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    modelStates.push(state);
    businessEvidence.provider_requests = state.requests;
    assert.deepEqual(
      state.errors,
      [],
      "model fixture rejected an unexpected execution",
    );
    return state.requests;
  };
  const exec = (container, shell) =>
    docker(["exec", "--user", "1000:1000", container, "sh", "-c", shell]);
  const effects = async () =>
    Buffer.from(
      await exec(
        initial.container.Id,
        "base64 -w 0 /workspace/.c3-run-effects",
      ),
      "base64",
    ).toString();
  async function blocked(requestID) {
    await exec(initial.container.Id, heldProcessCommand(pid));
    assertDrain({
      initial,
      requestID,
      operation: await json(`/api/admin/operations/${requestID}`),
      agent: await json(`/api/admin/agents/${agentID}`),
      containers: (await resources(agentID)).containers,
      effects: await effects(),
      attachment: (await json(`/api/admin/agents/${agentID}/network-policy`))
        .attachment.state,
      settled,
    });
  }
  try {
    client = await access.open(agentID, owner, principal);
    const session = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    const other = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    prompt = client
      .request(
        "prompt",
        { sessionId: session, prompt: [{ type: "text", text: "c3-held-run" }] },
        180000,
        { kind: "ordinary", phase: "c3-held-run" },
      )
      .then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
    let entered = false;
    for (let i = 0; i < 100; i++) {
      entered =
        (await exec(
          initial.container.Id,
          "if [ -f /workspace/.c3-run-started ]; then printf entered; fi",
        )) === "entered";
      if (entered) break;
      assert(!settled, "held prompt ended before the real tool barrier");
      await delay(200);
    }
    assert(entered, "Runtime bash did not enter the held barrier");
    pid = await exec(initial.container.Id, "cat /workspace/.c3-run-started");
    await exec(initial.container.Id, heldProcessCommand(pid));
    const firstRequests = await modelState();
    assert.deepEqual(
      firstRequests.map((r) => [r.phase, r.stage]),
      [["c3-held-run", "tool"]],
    );
    const heldAudit = (await audits(session)).filter(
      (r) => r.state === "running",
    );
    assert.equal(heldAudit.length, 1);
    const heldRunId = heldAudit[0].run_id;
    const originalExecution = (await saved(heldRunId)).run.execution_snapshot;
    const deny = async () => {
      const before = {
        page: await auditPage(other),
        model_requests: await modelState(),
        updates: structuredClone(
          client.updates.filter((u) => u.sessionId === other),
        ),
      };
      const checkpoint = {
        request_id: null,
        session_id: other,
        before,
        after: null,
      };
      businessEvidence.busy_checks.push(checkpoint);
      assert.deepEqual(before.page.items, []);
      const requestIndex = client.snapshot().evidence.length;
      try {
        await assert.rejects(
          client.request(
            "prompt",
            { sessionId: other, prompt: [{ type: "text", text: "c3-denied" }] },
            15000,
            { rejection: "agent_busy" },
          ),
          (error) => isBusyDenied(error),
        );
      } finally {
        checkpoint.request_id =
          client.snapshot().evidence[requestIndex]?.requestId ?? null;
      }
      checkpoint.after = {
        page: await auditPage(other),
        model_requests: await modelState(),
        updates: structuredClone(
          client.updates.filter((u) => u.sessionId === other),
        ),
      };
      assert.deepEqual(checkpoint.after.updates, before.updates);
      assert.deepEqual(checkpoint.after.page, before.page);
      assert.deepEqual(
        checkpoint.after.model_requests,
        firstRequests,
        "denied prompt reached the model",
      );
      assert.deepEqual(checkpoint.after.model_requests, before.model_requests);
    };
    let controllerRestart;
    const rebuild = await command(
      "rebuild",
      agentID,
      {
        template_id: template.template_id,
        template_revision: template.revision,
      },
      { workerRestart: true },
      async ({ requestID, path, options }) => {
        await until(
          async () =>
            (await access.state(agentID, owner, principal))
              .unavailable_reason === "agent_unavailable",
          "ACP drain publication",
        );
        await blocked(requestID);
        await deny();
        const ids = lines(
          await docker(config.compose(["ps", "-q", "agent-controller"])),
        );
        assert.equal(ids.length, 1);
        const before = JSON.parse(await docker(["inspect", ids[0]]))[0];
        assert.equal(
          before.Config.Labels["com.docker.compose.project"],
          config.project,
        );
        await docker(
          config.compose(["stop", "-t", "20", "agent-controller"]),
          true,
        );
        const stopped = JSON.parse(await docker(["inspect", ids[0]]))[0];
        assertControllerStopped(before, stopped, config.project);
        await docker(
          config.compose([
            "up",
            "-d",
            "--no-build",
            "--wait",
            "--wait-timeout",
            "120",
            "--no-deps",
            "agent-controller",
          ]),
          true,
        );
        const after = JSON.parse(await docker(["inspect", ids[0]]))[0];
        assert.notEqual(
          after.State.StartedAt,
          before.State.StartedAt,
          "controller did not restart",
        );
        assert.equal(after.State.Health.Status, "healthy");
        controllerRestart = {
          nonterminal_phase: "drain",
          graceful: true,
          exit_code: stopped.State.ExitCode,
          process_restart_verified: true,
        };
        await blocked(requestID);
        await deny();
        const replay = await json(path, options);
        assert.equal((replay.operation ?? replay).request_id, requestID);
        await blocked(requestID);
        await exec(initial.container.Id, heldProcessCommand(pid, true));
        const result = await prompt;
        if (result.error) throw result.error;
        assert.equal(result.value.stopReason, "end_turn");
        const completed = (await saved(heldRunId)).run;
        assertCompletedExecution(completed, initial.agent);
        assert.deepEqual(completed.execution_snapshot, originalExecution);
      },
    );
    const rebuilt = await ready(agentID);
    businessEvidence.execution_revisions["c3-after-rebuild"] =
      rebuilt.agent.executable_execution_revision;
    assert.notEqual(rebuilt.container.Id, initial.container.Id);
    assert.notEqual(
      rebuilt.agent.executable_execution_revision,
      initial.agent.executable_execution_revision,
    );
    await client.closeAndWait();
    client = await access.open(agentID, owner, principal);
    const beforeReplay = await saved(heldRunId),
      beforeReplayCalls = await modelState();
    await client.request("load", {
      sessionId: session,
      cwd: "/workspace",
      mcpServers: [],
    });
    assertCatalog(client.updates, session);
    assertReplay(1, client.updates, beforeReplay, session);
    assert.deepEqual(await saved(heldRunId), beforeReplay);
    assert.deepEqual(await modelState(), beforeReplayCalls);
    const offset = client.updates.length;
    const next = await client.request(
      "prompt",
      {
        sessionId: session,
        prompt: [{ type: "text", text: "c3-after-rebuild" }],
      },
      60000,
      { kind: "ordinary", phase: "c3-after-rebuild", toolName: "read" },
    );
    assert.equal(next.stopReason, "end_turn");
    const afterRuns = await audits(session);
    assert.equal(afterRuns.length, 2);
    const fresh = afterRuns.find((r) => r.run_id !== heldRunId);
    assert(fresh && fresh.state === "completed");
    const current = (await saved(fresh.run_id)).run;
    assertCompletedExecution(current, rebuilt.agent);
    const answer = client.updates
      .slice(offset)
      .filter(
        (n) =>
          n.sessionId === session &&
          n.update.sessionUpdate === "agent_message_chunk",
      )
      .map((n) => n.update.content.text ?? "")
      .join("");
    assert.equal(answer, "c3-after-rebuild completed");
    const requests = await modelState();
    assert.deepEqual(
      requests.map((r) => [r.phase, r.stage]),
      [
        ["c3-held-run", "tool"],
        ["c3-held-run", "reply"],
        ["c3-after-rebuild", "tool"],
        ["c3-after-rebuild", "reply"],
      ],
    );
    await client.closeAndWait();
    businessEvidence.private_connections = access.snapshots();
    const collected = await collectFoundationBusinessEvidence(
      {
        agent_id: businessEvidence.agent_id,
        principal_id: businessEvidence.principal_id,
        private_connections: businessEvidence.private_connections,
        execution_revisions: businessEvidence.execution_revisions,
        busy_checks: businessEvidence.busy_checks,
        provider_requests: requests,
      },
      {
        signal,
        readJSON: async (path, { signal: localSignal }) => {
          localSignal?.throwIfAborted();
          return readAudit(path);
        },
        preserve(evidence, failure) {
          businessEvidence = evidence;
          writeEvidenceFile(
            config.evidence,
            "foundation-business-collection.private.json",
            JSON.stringify({
              evidence,
              ...(failure ? { failure: inspect(failure, { depth: 8 }) } : {}),
            }),
          );
        },
      },
    );
    const runIds = {
      "c3-held-run": heldRunId,
      "c3-after-rebuild": fresh.run_id,
    };
    const observed = access.snapshots().flatMap((connection) =>
      [connection.initialization, ...connection.evidence].map((row) => ({
        ...row,
        ...(row.kind === "ordinary" ? { runId: runIds[row.phase] } : {}),
      })),
    );
    let traces;
    if (traceDiagnostics) {
      traces = [];
      for (const [index, expected] of observed.entries()) {
        const diagnostic = await traceDiagnostics.run(
          `foundation-request-${index}`,
          (localSignal) => access.collect(expected, requests, localSignal),
        );
        traces.push(
          diagnostic.status === "passed"
            ? diagnostic.value
            : { method: expected.method, diagnostic },
        );
      }
    } else {
      traces = await collectFoundationRequests(
        observed,
        (expected) => access.collect(expected, requests),
        signal,
      );
    }
    output = {
      rebuild,
      evidence: {
        completed_prompts: 2,
        denied_prompts: 2,
        controller_restart: controllerRestart,
        same_session_after_rebuild: true,
        physical_tool_effects_exact: true,
        run_traces: traces,
        run_ids: [heldRunId, fresh.run_id],
        private_business: collected.evidence,
        execution: collected.summary,
        provider_requests: requests.map(({ phase, stage, trace_id }) => ({
          phase,
          stage,
          trace_id,
        })),
      },
    };
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await access.closeAndWait();
    } catch (error) {
      errors.push(error);
    }
    if (prompt) {
      const result = await prompt;
      if (result.error) errors.push(result.error);
    }
    if (signal?.aborted) errors.push(signal.reason);
    try {
      writeEvidenceFile(
        config.evidence,
        "foundation-business-progress.private.json",
        JSON.stringify({
          ...businessEvidence,
          private_connections: access.snapshots(),
          original_reads: originalReads,
          model_states: modelStates,
          errors: errors.map((error) => inspect(error, { depth: 8 })),
        }),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  const failures = [...new Set(errors)];
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Foundation business and private cleanup failed",
    );
  output.evidence.private_connections = access.snapshots();
  output.evidence.private_state_receipts = access.stateReceipts();
  output.evidence.cleanup_completed = true;
  return output;
}
