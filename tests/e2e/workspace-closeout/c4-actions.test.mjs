import assert from "node:assert/strict";
import test from "node:test";
import { note } from "./browser-model.mjs";
import { c4InventoryFixture } from "./c4-inventory.fixture.mjs";
const url = new URL("./c4-actions.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture(overrides = {}) {
  assert.equal(typeof implementation.createC4Actions, "function");
  const abort = new AbortController(),
    report = { checks: [], traces: [] },
    events = [];
  const config = {
    project: "antnest-lifecycle-12345678",
    env: {},
    model: "http://model.test",
    compose: (args) => ["compose", ...args],
  };
  const container = {
    Id: "ui",
    Config: {
      Labels: {
        "com.docker.compose.project": config.project,
        "com.docker.compose.service": "agent-ui",
      },
    },
    State: { Running: false, ExitCode: 0, OOMKilled: false },
  };
  const dependencies = {
    createDocker: (_env, signal) => async (args) => {
      events.push({ args, signal });
      if (args[0] === "inspect") return JSON.stringify([container]);
      if (args.includes("ps")) return "ui";
      return "";
    },
    flushShared: async () => {
      events.push({ shared: true });
      return 7;
    },
    write: () => {},
    ...overrides,
  };
  return {
    abort,
    report,
    config,
    events,
    container,
    actions: implementation.createC4Actions(
      {
        signal: abort.signal,
        report,
        output: "artifacts/verification/c4-test",
      },
      dependencies,
    ),
  };
}
test("C4 workspace bytes remain bound to the full rebuilt container identity", async () => {
  const id = "a".repeat(64),
    member = { agentID: "agent" },
    captures = [];
  const f = fixture({
    setup: async () => member,
    captureRuntime: async (name) => {
      captures.push(name);
    },
    createDocker: () => async (args) =>
      args[0] === "ps"
        ? args.includes("--no-trunc")
          ? id
          : id.slice(0, 12)
        : Buffer.from(note).toString("base64"),
  });
  const actual = await f.actions.setup(f.config, f.report);
  await actual.verifyWorkspace();
  assert.deepEqual(captures, ["initial"]);
  assert.equal(f.report.workspace_receipt.container_id, id);
  assert.equal(
    Buffer.from(f.report.workspace_receipt.encoded, "base64").toString(),
    note,
  );
});
test("C4 business completion cannot bypass missing browser acceptance checks", () => {
  const f = fixture();
  assert.throws(
    () => f.actions.admit(f.report, f.config),
    /browser business incomplete/u,
  );
  f.report.business_completed = true;
  assert.throws(
    () => f.actions.admit(f.report, f.config),
    /complete C4 browser checks/u,
  );
});
test("C4 action captures its owned project before configuration can fail", async () => {
  const error = new Error("original configure failure");
  const f = fixture({
    configuration: async (_signal, allocated) => {
      allocated("antnest-lifecycle-12345678");
      throw error;
    },
  });
  let scope;
  await assert.rejects(
    f.actions.configure((value) => {
      scope = value;
    }),
    (e) => e === error,
  );
  assert.equal(scope.project, f.config.project);
  assert(scope.env);
});
test("C4 flush joins Agent UI before all seven shared producers", async () => {
  const f = fixture();
  await f.actions.flush(f.config, f.report);
  assert(f.events[0].args.includes("stop"));
  assert(f.events[0].args.includes("agent-ui"));
  assert.equal(f.events.at(-1).shared, true);
  assert.deepEqual(f.report.producer_flush.agent_ui, f.container);
  assert.equal(f.report.producer_flush.shared_services, 7);
});
test("C4 still flushes independent shared producers after an Agent UI flush failure", async () => {
  const original = new Error("original UI flush error");
  let shared = 0;
  const f = fixture({
    createDocker: () => async () => {
      throw original;
    },
    flushShared: async () => {
      shared++;
      return 7;
    },
  });
  await assert.rejects(
    f.actions.flush(f.config, f.report),
    (e) => e === original || e.errors.includes(original),
  );
  assert.equal(shared, 1);
  assert.equal(f.report.producer_flush.completed, undefined);
});
test("C4 refresh reads a new model observation when refreshing execution audits", async () => {
  const fresh = { requests: [], pending: [], errors: [] };
  const f = fixture({
    request: async () => Response.json(fresh),
    snapshot: async (_fixture, model) => ({
      audits: { all: [] },
      model: await model(),
    }),
  });
  f.report.model = { requests: ["stale"] };
  await f.actions.refreshAudits(f.config, {}, f.report);
  assert.deepEqual(f.report.execution.model, fresh);
  assert.deepEqual(f.report.model, { requests: ["stale"] });
});
test("C4 failure logs and cleanup use an independent signal after parent interruption", async () => {
  let cleaned;
  const f = fixture({
    cleanup: async (config) => {
      cleaned = config;
    },
  });
  f.abort.abort(new Error("parent interrupted"));
  await f.actions.logs(f.config, f.report);
  assert(f.events.length > 0);
  assert(f.events.every((event) => event.signal === undefined));
  await f.actions.cleanup(f.config, f.report);
  assert.equal(cleaned.project, f.config.project);
});

function admissionFixture(strictAvailable) {
  const f = fixture(),
    inventory = c4InventoryFixture(),
    sessionId = inventory.sessions["c4-browser-mobile"],
    gateway = "http://gateway",
    loginURL =
      gateway +
      "/?" +
      new URLSearchParams({
        return_to: `/workspace/${inventory.agent_id}/sessions/${sessionId}`,
      }),
    responseURL =
      gateway +
      `/api/app/workspace/v1/agents/${inventory.agent_id}/view?sessionId=${sessionId}`,
    loginNavigation = {
      pageId: 1,
      fromGeneration: 3,
      toGeneration: 4,
      url: loginURL,
      atMono: 30,
    };
  f.config.gateway = gateway;
  Object.assign(f.report, inventory, {
    business_completed: true,
    checks: [
      "workspace context above conversation navigation",
      "member_login_new_load_session_real_tools",
      "cross_page_metadata_matches_list_and_reload",
      "attachment_bytes_previews_format_and_capability_rejections",
      "real_tool_permission_interaction",
      "two_sessions_busy_cancel_and_readmission",
      "offline_completion_history_without_resubmission",
      "close_reopen_history_without_resubmission",
      "open_page_rebuild_retains_workspace_and_history",
      "mobile_layout_input_completion",
      "open_page_identity_revocation",
      "private_runtime_and_provider_data_absent",
    ],
    browser_errors: 0,
    browser_payloads_checked: 1,
    workspace_receipt: {
      container_id: inventory.runtime_bindings[1].observed.container.Id,
      encoded: Buffer.from(note).toString("base64"),
    },
    producer_flush: {
      completed: true,
      shared_services: 7,
      agent_ui: structuredClone(f.container),
    },
    browser_revocation: {
      before: structuredClone(inventory.execution),
      cause: { status: 200, traceID: "b".repeat(32), startedMono: 20 },
      selectedView: { agentId: inventory.agent_id, sessionId },
      bodyObservation: {
        pageId: 1,
        sessionId,
        startedMono: 20,
        loginURL,
        loginNavigation: structuredClone(loginNavigation),
        confirmedMono: 50,
        signInVisible: true,
        composerCount: 0,
        messageCount: 0,
      },
    },
    browser_body_diagnostics: [
      {
        id: 1,
        pageId: 1,
        generation: 3,
        agentId: inventory.agent_id,
        sessionId,
        url: responseURL,
        requestURL: responseURL,
        method: "GET",
        status: 200,
        traceID: "a".repeat(32),
        mainFrame: true,
        redirected: false,
        startedMono: 10,
        revocationStartedMono: 20,
        failedMono: 40,
        loginNavigation: structuredClone(loginNavigation),
        body: "not_observed",
        raw_error: {
          name: "Error",
          message:
            "response.text: Protocol error (Network.getResponseBody): No resource with given identifier found\nResponse body is not available for a response that was navigated away from.",
        },
      },
    ],
    bootstrap_denials: [],
    browser_bodies_unobserved: 1,
    browser_payload_coverage: "observed_bodies_only",
  });
  if (strictAvailable)
    f.report.trace_outcome = {
      exit_code: 2,
      strict_trace: "failed",
      reviewed_error_spans: 2,
    };
  return f;
}

for (const strictAvailable of [false, true]) {
  const strict = strictAvailable
    ? "recorded strict exit 2"
    : "unavailable Trace";
  test(`C4 real action admits complete independent business and reviews original body proof with ${strict}`, () => {
    const f = admissionFixture(strictAvailable);
    assert.deepEqual(f.actions.admit(f.report, f.config), {
      exitCode: 0,
      rawExitCode: strictAvailable ? 2 : null,
      strict_trace: strictAvailable ? "failed" : "not_collected",
      reviewed_error_spans: strictAvailable ? 2 : 0,
      runs: 11,
      provider_requests: 14,
      runtime_tool_calls: 4,
      trace_roots: 0,
    });
    assert.deepEqual(f.report.browser_body_review, {
      status: "accepted_external_observation",
      body_count: 1,
      body_ids: [1],
    });
  });

  for (const [name, mutate] of [
    [
      "missing original body proof",
      (report) => {
        delete report.browser_revocation.bodyObservation;
      },
    ],
    [
      "foreign body Session",
      (report) => {
        report.browser_body_diagnostics[0].sessionId = "foreign-session";
      },
    ],
    [
      "unknown unread response status",
      (report) => {
        report.browser_body_diagnostics[0].status = 500;
      },
    ],
    [
      "body count gap",
      (report) => {
        report.browser_bodies_unobserved++;
      },
    ],
    [
      "claim that unread bodies were audited",
      (report) => {
        report.browser_payload_coverage = "all_bodies";
      },
    ],
    [
      "unobserved browser payloads",
      (report) => {
        report.browser_payloads_checked = 0;
      },
    ],
    [
      "missing durable Run",
      (report) => {
        report.execution.audits.all.pop();
      },
    ],
    [
      "foreign authenticated owner",
      (report) => {
        report.page_login.issued.principal.user_id = "foreign-owner";
      },
    ],
    [
      "changed revocation execution baseline",
      (report) => {
        report.browser_revocation.before.audits.all.pop();
      },
    ],
    [
      "reused Runtime container",
      (report) => {
        report.runtime_bindings[1].observed.container.Id =
          report.runtime_bindings[0].observed.container.Id;
      },
    ],
    [
      "changed workspace bytes",
      (report) => {
        report.workspace_receipt.encoded =
          Buffer.from("changed").toString("base64");
      },
    ],
    [
      "incomplete seven-service stop",
      (report) => {
        report.producer_flush.shared_services = 6;
      },
    ],
    [
      "still-running Agent UI",
      (report) => {
        report.producer_flush.agent_ui.State.Running = true;
      },
    ],
    [
      "abnormal Agent UI exit",
      (report) => {
        report.producer_flush.agent_ui.State.ExitCode = 1;
      },
    ],
  ])
    test(`C4 real action rejects ${name} with ${strict}`, () => {
      const f = admissionFixture(strictAvailable);
      mutate(f.report);
      assert.throws(() => f.actions.admit(f.report, f.config));
    });
}
