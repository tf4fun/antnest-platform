import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import {
  collectManagedTrace,
  inspectManagedTrace,
} from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import { saveFoundationTrace } from "./foundation-trace.mjs";
import { assertCompletedExecution } from "./foundation-evidence.mjs";
import { isBusyDenied } from "../managed-mcp/drain.mjs";
import { assertReplay } from "../acp-persistence/evidence.mjs";
import { assertCatalog } from "../acp-commands/evidence.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { connectOwner } from "./acp.mjs";
import {
  assertDrain,
  assertControllerStopped,
  heldProcessCommand,
} from "./drain-evidence.mjs";
import { lines } from "./docker.mjs";

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
}) {
  const owner = new GatewayClient(config.gateway);
  await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  let client = connectOwner(config.gateway, agentID, owner.cookie, signal);
  let settled = false;
  let prompt;
  let pid;
  const observed = [];
  const remember = (client, method, details = {}) => {
    const request = client.requests.filter((r) => r.method === method).at(-1);
    assert(request, "actual SDK request missing");
    const value = {
      ...request,
      agentId: agentID,
      connectionTraceID: client.connectionTraceID,
      transport: "websocket",
      kind: "request",
      ...details,
    };
    observed.push(value);
    return value;
  };
  const audits = async (sessionId) => {
    const value = await json(
      `/api/admin/execution-audits?agent_id=${agentID}&session_id=${sessionId}`,
    );
    assert.equal(value.next_cursor, null);
    return value.items;
  };
  const saved = async (id) => {
    const run = await json(`/api/admin/execution-audits/${id}`);
    const events = await json(
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
    await client.initialize();
    const session = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    remember(client, "session/new", { sessionId: session });
    const other = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    remember(client, "session/new", { sessionId: other });
    prompt = client
      .request(
        "prompt",
        { sessionId: session, prompt: [{ type: "text", text: "c3-held-run" }] },
        180000,
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
    remember(client, "session/prompt", {
      kind: "ordinary",
      phase: "c3-held-run",
      runId: heldRunId,
    });
    const deny = async () => {
      const beforeUpdates = client.updates.filter((u) => u.sessionId === other);
      const before = await audits(other);
      assert.deepEqual(before, []);
      await assert.rejects(
        client.request("prompt", {
          sessionId: other,
          prompt: [{ type: "text", text: "c3-denied" }],
        }),
        (error) => {
          return isBusyDenied(error);
        },
      );
      assert.deepEqual(
        client.updates.filter((u) => u.sessionId === other),
        beforeUpdates,
      );
      assert.deepEqual(await audits(other), before);
      remember(client, "session/prompt", { rejection: "agent_busy" });
      assert.deepEqual(
        await modelState(),
        firstRequests,
        "denied prompt reached the model",
      );
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
            (await owner.request(`/api/app/agents/${agentID}/state`)).body
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
        assert(
          !result.error,
          `held Run failed: ${result.error?.data?.code ?? "unknown"}`,
        );
        assert.equal(result.value.stopReason, "end_turn");
        const completed = (await saved(heldRunId)).run;
        assertCompletedExecution(completed, initial.agent);
        assert.deepEqual(completed.execution_snapshot, originalExecution);
      },
    );
    const rebuilt = await ready(agentID);
    assert.notEqual(rebuilt.container.Id, initial.container.Id);
    assert.notEqual(
      rebuilt.agent.executable_execution_revision,
      initial.agent.executable_execution_revision,
    );
    client.close();
    client = connectOwner(config.gateway, agentID, owner.cookie, signal);
    await client.initialize();
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
    remember(client, "session/load");
    const offset = client.updates.length;
    const next = await client.request(
      "prompt",
      {
        sessionId: session,
        prompt: [{ type: "text", text: "c3-after-rebuild" }],
      },
      60000,
    );
    assert.equal(next.stopReason, "end_turn");
    const afterRuns = await audits(session);
    assert.equal(afterRuns.length, 2);
    const fresh = afterRuns.find((r) => r.run_id !== heldRunId);
    assert(fresh && fresh.state === "completed");
    const current = (await saved(fresh.run_id)).run;
    assertCompletedExecution(current, rebuilt.agent);
    remember(client, "session/prompt", {
      kind: "ordinary",
      phase: "c3-after-rebuild",
      toolName: "read",
      runId: fresh.run_id,
    });
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
    client.close();
    const traces = [];
    const secrets = [
      "stage3-model-secret",
      "lifecycle-owner-password",
      ...owner.cookies.values(),
    ];
    for (const expected of observed)
      traces.push(
        await collectManagedTrace(
          config.jaeger,
          expected,
          secrets,
          requests,
          (trace) => saveFoundationTrace(config, trace),
          (trace, expected, secrets, calls) => {
            const result = expected.rejection
              ? inspectManagedTrace(trace, expected, secrets, calls)
              : inspectCommandTrace(trace, expected, secrets, calls);
            if (expected.runId)
              assert.equal(
                result.run_id,
                expected.runId,
                "request trace belongs to another Run",
              );
            return {
              ...strictSessionEvidence(result, trace),
              topology: "passed",
            };
          },
          signal,
        ),
      );
    return {
      rebuild,
      evidence: {
        completed_prompts: 2,
        denied_prompts: 2,
        controller_restart: controllerRestart,
        same_session_after_rebuild: true,
        physical_tool_effects_exact: true,
        run_traces: traces,
      },
    };
  } finally {
    client.close();
    if (prompt) await prompt;
  }
}
