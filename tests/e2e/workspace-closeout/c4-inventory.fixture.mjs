import { note, imageData } from "./browser-model.mjs";
import { audioData } from "../acp-multimodal/fixtures.mjs";

export function c4InventoryFixture() {
  const plans = [
    ["write", ["tool", "reply"], "bash"],
    ["read", ["tool", "reply"], "read"],
    ["attachments", ["reply"]],
    ["unsupported-audio", []],
    ["approve", ["tool", "reply"], "read"],
    ["hold-cancel", ["reply"]],
    ["after-cancel", ["reply"]],
    ["hold-offline", ["reply"]],
    ["hold-close", ["reply"]],
    ["after-rebuild", ["tool", "reply"], "read"],
    ["mobile", ["reply"]],
  ];
  const report = {
    agent_id: "agent",
    runtime_image_id: "sha256:original-runtime",
    page_login: { issued: { principal: { user_id: "owner" } } },
    sessions: {},
    prompt_receipts: [],
    runtime_bindings: [],
    execution: {
      audits: { page: { items: [], next_cursor: null }, all: [] },
      model: { requests: [], pending: [], errors: [] },
    },
  };
  for (const [index, name] of ["initial", "rebuilt"].entries()) {
    const generation = index + 1;
    report.runtime_bindings.push({
      name,
      physical: {
        id: `container-${generation}`,
        volume: "original-workspace-volume",
        running: true,
        healthy: true,
      },
      observed: {
        agent: {
          agent_id: "agent",
          owner_user_id: "owner",
          executable_execution_revision: `execution-${generation}`,
          runtime: { runtime_revision: `runtime-${generation}` },
        },
        container: {
          Id: `container-${generation}`,
          Image: report.runtime_image_id,
          State: { Running: true, Health: { Status: "healthy" } },
          Config: {
            Labels: {
              "io.antnest.agent-id": "agent",
              "io.antnest.runtime-generation": String(generation),
            },
          },
        },
        volume: "original-workspace-volume",
      },
      status: {
        status: "ready",
        agent_id: "agent",
        generation,
        execution_id: `runtime-execution-${generation}`,
      },
      binding: {
        runtime_revision: `runtime-${generation}`,
        runtime_execution_id: `runtime-execution-${generation}`,
      },
    });
  }
  for (const [index, [suffix, stages, tool]] of plans.entries()) {
    const phase = "c4-browser-" + suffix,
      generation = index < 9 ? 1 : 2,
      sessionId = ["unsupported-audio", "after-cancel", "mobile"].includes(
        suffix,
      )
        ? "session-" + suffix
        : "session-original",
      traceID = (index + 1).toString(16).padStart(32, "0"),
      intentId = "intent-" + index,
      input = [{ type: "text", text: phase }];
    if (suffix === "attachments")
      input.push(
        {
          type: "resource",
          resource: {
            uri: "attachment:///workspace-notes.md",
            mimeType: "text/markdown",
            text: note,
          },
        },
        { type: "image", mimeType: "image/png", data: imageData },
      );
    if (suffix === "unsupported-audio")
      input.push({ type: "audio", mimeType: "audio/wav", data: audioData });
    const state =
        suffix === "hold-cancel"
          ? "cancelled"
          : suffix === "unsupported-audio"
            ? "failed"
            : "completed",
      run = {
        run_id: "run-" + index,
        agent_id: "agent",
        principal_id: "owner",
        session_id: sessionId,
        input,
        state,
        terminal_class: state,
        executor_state: "quiescent",
        tool_effect_state: tool ? "settled" : "none",
        stop_reason: state === "completed" ? "end_turn" : null,
        error_class: state === "failed" ? "model_unsupported_content" : null,
        execution_snapshot: { executionRevision: "execution-" + generation },
      };
    report.sessions[phase] = sessionId;
    report.execution.audits.page.items.push({
      run_id: run.run_id,
      agent_id: "agent",
      session_id: sessionId,
      principal_id: "owner",
      state,
    });
    report.execution.audits.all.push({
      run,
      events: { stream: "execution", next_cursor: null, items: [] },
    });
    const body = {
        intentId,
        expectedAppendVersion: 0,
        prompt: structuredClone(input),
      },
      accepted = {
        operationId: intentId,
        acceptance: "bridge",
        phase: "dispatching",
      };
    report.prompt_receipts.push({
      agentId: "agent",
      sessionId,
      phase,
      traceID,
      method: "POST",
      status: 202,
      path: `/api/app/workspace/v1/agents/agent/sessions/${sessionId}/prompts`,
      original_browser_authority: true,
      request: {
        body,
        rawBody: JSON.stringify(body),
        historyToken: "original-history",
      },
      body: accepted,
      rawBody: JSON.stringify(accepted),
    });
    for (const [stageIndex, stage] of stages.entries())
      report.execution.model.requests.push({
        phase,
        stage,
        trace_id: traceID,
        model_span_id: (index * 2 + stageIndex + 1)
          .toString(16)
          .padStart(16, "0"),
        ...(suffix === "hold-cancel" ? { disconnected: true } : {}),
      });
    if (suffix === "hold-cancel")
      report.cancelled_run = {
        operationId: intentId,
        acceptance: "acp",
        phase: "running",
        runId: run.run_id,
        sessionId,
        agentId: "agent",
      };
  }
  report.model = structuredClone(report.execution.model);
  return report;
}
