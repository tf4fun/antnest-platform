import assert from "node:assert/strict";

export const developmentDriverOrder = [
  "state-before",
  "replay-before",
  "chat-trace",
  "rejection-trace",
  "lifecycle",
  "runtime-loss",
  "recover",
  "state-after",
  "replay-after",
];
const checks = [
  "browser_admin_login",
  "blank_business_inventory",
  "provider_created_through_console",
  "template_created_through_console",
  "agent_operation_completed_and_runtime_available",
  "console_open_chat_same_agent",
  "controlled_provider_greeting",
  "real_runtime_tools_and_collapsed_activity",
  "server_history_replayed_without_resubmission",
  "real_tool_execution_after_history_restore",
  "mobile_chat_no_horizontal_overflow",
  "workspace_requires_explicit_agent_choice",
  "gateway_acp_model_runtime_trace_ancestry",
];
export function assertDevelopmentAcceptance(report) {
  const browser = report.browser;
  assert.equal(report.browser_command.complete, true);
  assert.equal(report.browser_command.exit_code, 0);
  assert.equal(browser.status, "passed");
  assert.equal(browser.provider.scope, "controlled");
  assert.equal(browser.provider.runtimeImage, report.runtime_image);
  assert.deepEqual(browser.checks, checks);
  assert.equal(browser.browser_errors, 0);
  assert.equal(browser.prompt_receipts.length, 3);
  assert.equal(
    new Set(browser.prompt_receipts.map((row) => row.traceID)).size,
    3,
  );
  assert.deepEqual(
    browser.prompt_results.map(
      (row) =>
        row.process.filter(
          (item) => item.kind === "tool" && item.status === "completed",
        ).length,
    ),
    [0, 2, 1],
  );
  assert.deepEqual(report.model.errors, []);
  assert(
    report.model.discoveries.length > 0,
    "Console must discover the controlled provider",
  );
  const phases = [
    ["greeting", 0, 0],
    ["write-read", 0, 1],
    ["write-read", 1, 1],
    ["write-read", 2, 1],
    ["restored-read", 0, 2],
    ["restored-read", 1, 2],
  ];
  assert.deepEqual(
    report.model.requests.map((row) => [row.phase, row.step, row.trace_id]),
    phases.map(([phase, step, index]) => [
      phase,
      step,
      browser.prompt_receipts[index].traceID,
    ]),
  );
  assert.equal(report.workspace.before, browser.workspace_marker);
  assert.equal(report.workspace.after, browser.workspace_marker);
  assert.equal(report.runtimes.length, 2);
  for (const runtime of report.runtimes)
    assert.equal(runtime.Image, report.runtime_digest);
  assert.equal(report.recovery_source.failure_stage, "runtime_observation");
  assert.equal(
    report.recovery_source.failure_code,
    "runtime_execution_changed",
  );
  assert.deepEqual(
    report.commands.map((row) => row.name),
    developmentDriverOrder,
  );
  for (const command of report.commands) {
    assert.equal(command.complete, true, command.name);
    assert.equal(command.exit_code, 0, command.name);
    const data = command.data;
    if (command.name.startsWith("state-")) {
      assert.equal(data.agent_id, browser.agent_id);
      assert.equal(data.execution_state.availability, "ready");
      assert.equal(data.execution_state.active_session_id, null);
      assert.equal(data.execution_state.access_allowed, true);
    } else if (command.name.startsWith("replay-")) {
      assert.equal(data.history_exact, true);
      assert.equal(data.new_runs, 0);
      assert.equal(data.new_tools, 0);
    } else if (["lifecycle", "runtime-loss"].includes(command.name)) {
      assert.equal(data.status, "passed");
      assert.deepEqual(
        data.lifecycle.map((item) => item.kind),
        ["create", "disable", "enable", "rebuild", "delete"],
      );
      assert.equal(data.publication.length, 3);
    } else if (command.name === "recover") assert.equal(data.status, "passed");
    else if (command.name === "chat-trace") assert.equal(data.length, 3);
    else if (command.name === "rejection-trace") {
      assert.equal(data.trace_id, report.rejection.traceID);
      assert.equal(data.error_class, "model_unsupported_content");
      assert.equal(report.rejection.code, data.error_class);
      assert.equal(data.model_requests, 0);
      assert.equal(data.runtime_tool_calls, 0);
    }
  }
  return {
    passed: true,
    provider_scope: "controlled",
    browser_checks: checks.length,
    model_requests: 6,
    runtime_tools: 3,
    drivers: developmentDriverOrder.length,
  };
}
