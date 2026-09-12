import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { verifyTraces } from "../observability/collect.mjs";
import { readAdmissionEvidence } from "./admission-evidence.mjs";
import { inspectRunTrace } from "./run-trace.mjs";
import { connectOwner } from "./acp.mjs";
import {
  assertDrain,
  assertRebuildDenial,
  assertControllerStopped,
  heldProcessCommand,
} from "./drain-evidence.mjs";
import { composeArgs, lines } from "./docker.mjs";

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
}) {
  const owner = new GatewayClient(config.gateway);
  await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  let client = connectOwner(config.gateway, agentID, owner.cookie);
  let settled = false;
  let prompt;
  let pid;
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
    const other = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
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
    const deny = async () => {
      await assert.rejects(
        client.request("prompt", {
          sessionId: other,
          prompt: [{ type: "text", text: "c3-denied" }],
        }),
        (error) => {
          assertRebuildDenial(error);
          return true;
        },
      );
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
      { template_id: template.template_id, template_revision: 2 },
      {},
      async ({ requestID, path, options }) => {
        await blocked(requestID);
        await deny();
        const ids = lines(
          await docker(
            composeArgs(config.project, ["ps", "-q", "agent-controller"]),
          ),
        );
        assert.equal(ids.length, 1);
        const before = JSON.parse(await docker(["inspect", ids[0]]))[0];
        assert.equal(
          before.Config.Labels["com.docker.compose.project"],
          config.project,
        );
        await docker(
          composeArgs(config.project, ["stop", "-t", "20", "agent-controller"]),
          true,
        );
        const stopped = JSON.parse(await docker(["inspect", ids[0]]))[0];
        assertControllerStopped(before, stopped, config.project);
        await docker(
          composeArgs(config.project, [
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
      },
    );
    const rebuilt = await ready(agentID);
    assert.notEqual(rebuilt.container.Id, initial.container.Id);
    assert.notEqual(
      rebuilt.agent.executable_execution_revision,
      initial.agent.executable_execution_revision,
    );
    client.close();
    client = connectOwner(config.gateway, agentID, owner.cookie);
    await client.initialize();
    await client.request("load", {
      sessionId: session,
      cwd: "/workspace",
      mcpServers: [],
    });
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
    const admissions = await readAdmissionEvidence(config, docker, agentID);
    const traces = await verifyTraces(
      config.jaeger,
      requests,
      [
        "stage3-model-secret",
        "lifecycle-owner-password",
        ...owner.cookies.values(),
      ],
      (trace, calls, secrets) =>
        inspectRunTrace(trace, calls, secrets, agentID, admissions),
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
