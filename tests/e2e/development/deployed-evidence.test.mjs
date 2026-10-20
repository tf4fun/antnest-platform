import assert from "node:assert/strict";
import test from "node:test";

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
function fixture() {
  const agent = "agent_fixture",
    marker = "ANTNEST-ACCEPTANCE-1",
    image = "antnest/antnest-runtime:shell-1234abcd",
    digest = "sha256:" + "a".repeat(64);
  const receipt = ["1", "2", "3"].map((s) => ({ traceID: s.repeat(32) }));
  const state = {
    agent_id: agent,
    execution_state: {
      availability: "ready",
      active_session_id: null,
      access_allowed: true,
    },
  };
  const replay = { history_exact: true, new_runs: 0, new_tools: 0 };
  const lifecycle = {
    status: "passed",
    lifecycle: ["create", "disable", "enable", "rebuild", "delete"].map(
      (kind) => ({ kind }),
    ),
    publication: [{}, {}, {}],
  };
  const rejection = {
    trace_id: "4".repeat(32),
    model_requests: 0,
    runtime_tool_calls: 0,
    error_class: "model_unsupported_content",
  };
  const data = [
    state,
    replay,
    [{}, {}, {}],
    rejection,
    lifecycle,
    lifecycle,
    { status: "passed" },
    state,
    replay,
  ];
  const names = [
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
  return {
    runtime_image: image,
    runtime_digest: digest,
    browser_command: { complete: true, exit_code: 0 },
    browser: {
      status: "passed",
      agent_id: agent,
      workspace_marker: marker,
      provider: { scope: "controlled", runtimeImage: image },
      checks,
      browser_errors: 0,
      prompt_receipts: receipt,
      prompt_results: [
        [],
        [
          { kind: "tool", status: "completed" },
          { kind: "tool", status: "completed" },
        ],
        [{ kind: "tool", status: "completed" }],
      ].map((process) => ({ process })),
    },
    model: {
      errors: [],
      discoveries: [{}],
      requests: [
        ["greeting", 0, 0],
        ["write-read", 0, 1],
        ["write-read", 1, 1],
        ["write-read", 2, 1],
        ["restored-read", 0, 2],
        ["restored-read", 1, 2],
      ].map(([phase, step, index]) => ({
        phase,
        step,
        trace_id: receipt[index].traceID,
      })),
    },
    commands: names.map((name, index) => ({
      name,
      complete: true,
      exit_code: 0,
      data: structuredClone(data[index]),
    })),
    workspace: { before: marker, after: marker },
    runtimes: [{ Image: digest }, { Image: digest }],
    recovery_source: {
      failure_stage: "runtime_observation",
      failure_code: "runtime_execution_changed",
    },
    rejection: {
      traceID: rejection.trace_id,
      code: "model_unsupported_content",
    },
  };
}
test("Development admission requires all real browser, provider, Runtime and driver evidence", async () => {
  const { assertDevelopmentAcceptance } =
    await import("./deployed-evidence.mjs");
  assert.equal(assertDevelopmentAcceptance(fixture()).passed, true);
});
for (const [name, change] of [
  ["missing driver", (r) => r.commands.pop()],
  [
    "incomplete child",
    (r) => {
      r.commands[0].complete = false;
    },
  ],
  [
    "failed child",
    (r) => {
      r.commands[4].exit_code = 1;
    },
  ],
  [
    "skipped Console initialization",
    (r) => {
      r.browser.checks = r.browser.checks.filter(
        (c) => c !== "blank_business_inventory",
      );
    },
  ],
  [
    "external provider",
    (r) => {
      r.browser.provider.scope = "external";
    },
  ],
  [
    "foreign Runtime image",
    (r) => {
      r.runtimes[1].Image = "sha256:" + "b".repeat(64);
    },
  ],
  [
    "unexpected provider request",
    (r) => {
      r.model.requests.push(structuredClone(r.model.requests[0]));
    },
  ],
  [
    "unbound provider Trace",
    (r) => {
      r.model.requests[1].trace_id = "f".repeat(32);
    },
  ],
  [
    "lost workspace",
    (r) => {
      r.workspace.after = "lost";
    },
  ],
  [
    "missing Runtime read",
    (r) => {
      r.browser.prompt_results[2].process = [];
    },
  ],
  [
    "wrong recovery precondition",
    (r) => {
      r.recovery_source.failure_code = "runtime_exited";
    },
  ],
  [
    "rejection called model",
    (r) => {
      r.commands[3].data.model_requests = 1;
    },
  ],
  [
    "replay inserted a Run",
    (r) => {
      r.commands[8].data.new_runs = 1;
    },
  ],
  [
    "lifecycle incomplete",
    (r) => {
      r.commands[5].data.lifecycle.pop();
    },
  ],
])
  test(`Development admission rejects ${name}`, async () => {
    const { assertDevelopmentAcceptance } =
      await import("./deployed-evidence.mjs");
    const value = fixture();
    change(value);
    assert.throws(() => assertDevelopmentAcceptance(value));
  });
