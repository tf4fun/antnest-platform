import { view } from "./resolve-cache-stream-fixtures.mjs";

const phase = "c4-cache-runtime-outage";
const marker = `${phase}: runtime output during identity outage.`;

export function bridgeOutageFixture() {
  const container = {
    id: "a".repeat(64),
    image: `sha256:${"b".repeat(64)}`,
    project: "outage-project",
    agent_id: "agent-1",
    started_at: "2026-10-14T00:00:00Z",
    restarts: 0,
    running: true,
    health: "healthy",
  };
  const runtime = {
    organization_id: "organization-1",
    runtime_revision: `rtv_${"c".repeat(32)}`,
    runtime_execution_id: "runtime-process-1",
    execution_revision: "execution-1",
    container,
    tool_id: "tool-call-1",
  };
  const operation = {
    operationId: "intent-1",
    sessionId: "session-1",
    acceptance: "acp",
    phase: "running",
    runId: "run-1",
    outputWatermark: 2,
  };
  const held = view("session-1", "cursor-2");
  held.operations = [operation];
  held.selectedView.operations = [operation];
  held.selectedView.turns = [
    {
      turnId: "run-1",
      outcome: "running",
      finalResponse: [],
      processVersion: 1,
      liveProcessDelta: {
        fromVersion: 0,
        items: [
          {
            index: 0,
            item: {
              id: "tool-call-1",
              kind: "tool",
              summary: "bash",
              status: "running",
              content: [{ type: "text", text: `Input: ${marker}` }],
              toolSections: { inputIndex: 0, detailStartIndex: 1 },
            },
          },
        ],
      },
    },
  ];
  const output = structuredClone(held);
  output.streamCursor = "cursor-3";
  output.selectedView.outputWatermark = 3;
  output.selectedView.turns[0].processVersion = 2;
  output.selectedView.turns[0].liveProcessDelta.fromVersion = 1;
  output.selectedView.turns[0].liveProcessDelta.items[0].item.content.push({
    type: "text",
    text: "stdout: " + marker + "\n",
  });
  const terminal = structuredClone(output);
  terminal.streamCursor = "cursor-4";
  terminal.availability = "offline";
  terminal.activeSessionId = null;
  terminal.selectedView.outputWatermark = 4;
  terminal.selectedView.turns[0].outcome = "unknown";
  delete terminal.selectedView.turns[0].liveProcessDelta;
  terminal.operations[0].phase = "uncertain";
  terminal.operations[0].errorClass = "cancelled_tool_outcome_unknown";
  terminal.selectedView.operations = structuredClone(terminal.operations);
  const http = (at, label, path, body, status = 200, method = "GET") => ({
    label,
    path,
    method,
    started_at: at - 5,
    at,
    status,
    trace_id: at.toString(16).padStart(32, "0"),
    set_cookie_count: 0,
    credential_scope: "owner-credential",
    body,
  });
  const session = "/api/app/workspace/v1/agents/agent-1/sessions/session-1";
  const snapshot = {
    executionRevision: runtime.execution_revision,
  };
  const run = {
    run_id: "run-1",
    agent_id: "agent-1",
    session_id: "session-1",
    principal_id: "user-1",
    state: "running",
    execution_snapshot: snapshot,
  };
  const heldProcesses =
    "30 (executor) S 1 30 0 0\n42 (bash) S 30 30 0 0\n43 (sleep) S 42 30 0 0";
  const observed = (at, processes, effects) => ({
    started_at: at - 10,
    at,
    container: structuredClone(container),
    status: { status: "ready", execution_id: runtime.runtime_execution_id },
    work: {
      pid: 42,
      pgid: 30,
      stat: processes.includes("42 (bash)") ? "42 (bash) S 30 30 0 0" : "",
      processes,
      effects,
    },
  });
  const stopped = {
    id: "d".repeat(64),
    project: "outage-project",
    service: "identity-service",
    started_at: "2026-10-14T00:00:00Z",
    finished_at: "2026-10-14T00:00:10Z",
    running: false,
    restarting: false,
    oom_killed: false,
    exit_code: 0,
    at: 1000,
  };
  return {
    policy_revision: 4,
    transport: "http-sse",
    project: "outage-project",
    agent_id: "agent-1",
    session_id: "session-1",
    intent_id: "intent-1",
    run_id: "run-1",
    session_deadlines: {
      owner: {
        principal: { organization_id: "organization-1", user_id: "user-1" },
      },
    },
    prompt: {
      ...http(
        200,
        "outage-prompt",
        `${session}/prompts`,
        {
          operationId: "intent-1",
          acceptance: "bridge",
          phase: "dispatching",
        },
        202,
        "POST",
      ),
      request: {
        intentId: "intent-1",
        expectedAppendVersion: 1,
        prompt: [{ type: "text", text: phase }],
      },
    },
    identity: {
      before: { ...stopped, running: true, at: 100 },
      stop_started_at: 900,
      stopped,
      stopped_end: { ...stopped, at: 6000 },
      restart_started_at: 6001,
      after: {
        ...stopped,
        running: true,
        at: 6100,
        started_at: "2026-10-14T00:00:16Z",
      },
    },
    runtime: {
      ...runtime,
      started: observed(350, heldProcesses, "started\n"),
      emit: {
        started_at: 1100,
        at: 1150,
        container_id: container.id,
        path: `/workspace/.${phase}-emit`,
      },
      before_cancel: observed(1400, heldProcesses, "started\nemitted\n"),
      quiescent: observed(1750, "1 (runtime) S 0 1 0 0", "started\nemitted\n"),
    },
    run_storage: {
      container_id: "9".repeat(64),
      project: "outage-project",
      database: "antnest_agent_acp",
      before: {
        label: "before-stop",
        started_at: 865,
        at: 875,
        record: {
          run_id: "run-1",
          session_id: "session-1",
          organization_id: "organization-1",
          agent_id: "agent-1",
          principal_id: "user-1",
          bridge_intent_id: "intent-1",
          state: "running",
          snapshot_organization_id: "organization-1",
          execution_revision: runtime.execution_revision,
          runtime_revision: runtime.runtime_revision,
          runtime_execution_id: runtime.runtime_execution_id,
          snapshot_sha256: "8".repeat(64),
        },
      },
      after: {
        label: "after-cancel",
        started_at: 1940,
        at: 1950,
        record: {
          run_id: "run-1",
          session_id: "session-1",
          organization_id: "organization-1",
          agent_id: "agent-1",
          principal_id: "user-1",
          bridge_intent_id: "intent-1",
          state: "unresolved",
          snapshot_organization_id: "organization-1",
          execution_revision: runtime.execution_revision,
          runtime_revision: runtime.runtime_revision,
          runtime_execution_id: runtime.runtime_execution_id,
          snapshot_sha256: "8".repeat(64),
        },
      },
    },
    stream: {
      status: 200,
      trace_id: "e".repeat(32),
      started_at: 250,
      headers_at: 260,
      set_cookie_count: 0,
      credential_scope: "owner-credential",
      path: "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
      records: [
        { at: 400, view: held },
        { at: 1300, view: output },
        { at: 1800, view: terminal },
      ],
    },
    cancel: {
      ...http(
        1550,
        "outage-cancel",
        `${session}/operations/intent-1/cancel`,
        { ...operation, phase: "cancelling" },
        200,
        "POST",
      ),
      request: { expectedRunId: "run-1" },
    },
    audit_before: http(
      850,
      "warm-console-audit",
      "/api/admin/execution-audits/run-1",
      run,
    ),
    audit: http(
      1850,
      "stopped-terminal-audit",
      "/api/admin/execution-audits/run-1",
      {
        ...run,
        state: "unresolved",
        terminal_class: "unresolved",
        executor_state: "quiescent",
        tool_effect_state: "unknown",
        error_class: "cancelled_tool_outcome_unknown",
        unknown_effect_source: "runtime_mcp",
        stop_reason: null,
      },
    ),
    model_started: {
      at: 300,
      state: {
        errors: [],
        pending: [],
        requests: [
          {
            phase,
            stage: "tool",
            trace_id: "f".repeat(32),
            model_span_id: "f".repeat(16),
            received_at_ms: 100,
          },
        ],
      },
    },
    model_cancelled: {
      at: 1900,
      state: {
        errors: [],
        pending: [],
        requests: [
          {
            phase,
            stage: "tool",
            trace_id: "f".repeat(32),
            model_span_id: "f".repeat(16),
            received_at_ms: 100,
          },
        ],
      },
    },
  };
}
