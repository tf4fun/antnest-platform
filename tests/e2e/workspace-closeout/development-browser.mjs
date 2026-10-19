import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import { gatewayBrowserRequest } from "../../support/gateway-browser-request.mjs";
import { durablePath } from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { collectDevelopmentChatTraces } from "../development/chat-trace.mjs";
import { createDevelopmentWriter } from "../../support/development-configuration.mjs";
import { readC4View } from "./c4-view.mjs";
import { captureC4PromptReceipt } from "./c4-prompt-receipt.mjs";
import {
  developmentCompletedTurn,
  readDevelopmentTurn,
  assertDevelopmentTurnContent,
  observeDevelopmentRequests,
  assertDevelopmentReload,
  runDevelopmentBrowserScope,
} from "./development-browser-flow.mjs";

// Real browser, Gateway, services, Runtime and model. Retains acceptance data.
const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    "env-file": { type: "string", default: ".env" },
    "secret-file": { type: "string", default: "../.secret" },
    agent: { type: "string" },
    output: { type: "string" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    "confirm-development": { type: "boolean", default: false },
  },
});
values["env-file"] = durablePath(values["env-file"]);
values["secret-file"] = durablePath(values["secret-file"]);
assert(values["confirm-development"], "development confirmation required");
const origin = new URL(values.gateway).origin;
assert(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const settings = parseEnv(readFileSync(values["env-file"], "utf8"));
const output = durablePath(
  values.output ?? "artifacts/verification/development-acceptance",
);
assert(
  !lstatSync(output, { throwIfNoEntry: false }),
  "use a fresh Development output directory",
);
process.umask(0o077);
await mkdir(output, { recursive: true, mode: 0o700 });
const write = createDevelopmentWriter({ output }, ["report.json"]);
const report = { status: "running", gateway: origin, traces: {}, checks: [] };
let scope, originalCookies;
const abort = new AbortController(),
  handlers = new Map();
for (const name of ["SIGINT", "SIGTERM"]) {
  const handler = () => abort.abort(new Error(name));
  handlers.set(name, handler);
  process.on(name, handler);
}
let stage = "launch";
const errors = [];
const frames = (report.view_frames = []);
const requests = (report.prompt_requests = []);
report.prompt_receipts = [];
report.prompt_results = [];
report.mutations = {};
function track(page) {
  page.setDefaultTimeout(20000);
  observeDevelopmentRequests(page, requests);
  page.on("pageerror", (error) => {
    errors.push("browser page error");
    scope.recordFailure(error);
  });
  page.on("websocket", () => {
    const error = new Error("unexpected Development browser WebSocket");
    errors.push(error.message);
    scope.recordFailure(error);
  });
}
async function mutation(page, path, status, action, name) {
  const pending = scope.track(
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "POST",
    ),
  );
  await action();
  const response = await pending;
  assert.equal(response.status(), status, `${name}: HTTP status`);
  report.traces[name] = response.headers()["x-antnest-trace-id"];
  const rawBody = await response.text();
  report.mutations[name] = {
    path,
    status: response.status(),
    traceID: report.traces[name],
    rawBody,
  };
  return JSON.parse(rawBody);
}
async function json(page, path) {
  const response = await gatewayBrowserRequest(page.context(), origin + path);
  assert.equal(response.status(), 200, `${path}: HTTP status`);
  return response.json();
}
async function until(page, check, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    const result = await check();
    if (result) return result;
    await page.waitForTimeout(500);
  }
  throw new Error(`${label}: deadline exceeded`);
}
async function login(page) {
  await page.goto(origin);
  await page
    .locator('[name="organization_slug"]')
    .fill(settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG);
  await page
    .locator('[name="email"]')
    .fill(settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL);
  await page
    .locator('[name="password"]')
    .fill(settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD);
  return mutation(
    page,
    "/api/session/login",
    200,
    () => page.getByRole("button", { name: "Sign in", exact: true }).click(),
    "login",
  );
}
async function initialize(page, principal) {
  for (const name of [
    "provider-connections",
    "model-profiles",
    "templates",
    "agents",
  ]) {
    const result = await json(page, `/api/admin/${name}`);
    assert.equal(result.items.length, 0, `${name}: expected blank instance`);
  }
  report.checks.push("blank_business_inventory");
  stage = "provider";
  await page.goto(`${origin}/#models`);
  await page
    .getByRole("button", { name: "Add provider", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  const secrets = parseEnv(readFileSync(values["secret-file"], "utf8"));
  assert(secrets.DEEPSEEK_API_KEY, "DeepSeek credential is required");
  await dialog.locator('[name="api_key"]').fill(secrets.DEEPSEEK_API_KEY);
  await dialog
    .getByRole("button", { name: "Select models", exact: true })
    .click();
  const targetModel = dialog.getByRole("checkbox", {
    name: "DeepSeek V4 Flash",
    exact: true,
  });
  await targetModel.waitFor({ state: "visible" });
  for (const checkbox of await dialog.getByRole("checkbox").all())
    await checkbox.uncheck();
  await targetModel.check();
  const provider = await mutation(
    page,
    "/api/admin/provider-connections",
    201,
    () =>
      dialog
        .getByRole("button", { name: "Connect provider", exact: true })
        .click(),
    "provider",
  );
  report.provider_id = provider.connection_id;
  const models = await json(page, "/api/admin/model-profiles");
  assert.equal(models.items.length, 1);
  const model = models.items[0];
  assert.equal(model.model.model, "deepseek-v4-flash");
  report.model_id = model.model_profile_id;
  report.checks.push("provider_created_through_console");
  console.log(
    JSON.stringify({ stage, status: "passed", trace: report.traces.provider }),
  );

  stage = "template";
  await page.goto(`${origin}/#templates`);
  await page
    .getByRole("button", { name: "Create template", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog");
  await dialog.locator('[name="name"]').fill("General assistant");
  await dialog
    .locator('[name="model_profile_id"]')
    .selectOption(model.model_profile_id);
  await dialog
    .locator('[name="system_prompt"]')
    .fill(
      "You are a helpful assistant. Use the available tools when needed and report their actual results.",
    );
  await dialog.locator('[name="max_model_requests"]').fill("16");
  const template = await mutation(
    page,
    "/api/admin/templates",
    201,
    () =>
      dialog
        .getByRole("button", { name: "Create template", exact: true })
        .click(),
    "template",
  );
  report.template_id = template.template_id;
  assert.equal(template.runtime.image_ref, "antnest/antnest-runtime:local");
  report.checks.push("template_created_through_console");
  console.log(
    JSON.stringify({ stage, status: "passed", trace: report.traces.template }),
  );

  stage = "agent";
  await page.goto(`${origin}/#agents`);
  await page
    .getByRole("button", { name: "Create Agent", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog");
  await dialog.locator('[name="name"]').fill("Assistant");
  await dialog
    .locator('[name="owner_user_id"]')
    .selectOption(principal.user_id);
  await dialog
    .locator('[name="template_id"]')
    .selectOption(template.template_id);
  const created = await mutation(
    page,
    "/api/admin/agents",
    202,
    () =>
      dialog.getByRole("button", { name: "Create Agent", exact: true }).click(),
    "agent",
  );
  report.agent_id = created.agent.agent_id;
  report.operation_id = created.operation.request_id;
  console.log(
    JSON.stringify({
      stage,
      status: "accepted",
      agent: report.agent_id,
      operation: report.operation_id,
      trace: report.traces.agent,
    }),
  );
  await until(
    page,
    async () => {
      const operation = await json(
        page,
        `/api/admin/operations/${report.operation_id}`,
      );
      assert(
        !["failed", "cancelled"].includes(operation.state),
        "Agent build failed",
      );
      const agent = await json(page, `/api/admin/agents/${report.agent_id}`);
      return (
        operation.state === "completed" &&
        agent.lifecycle_state === "created" &&
        agent.activation_state === "enabled" &&
        agent.runtime_state === "available"
      );
    },
    "Agent ready",
    240000,
  );
  report.checks.push("agent_operation_completed_and_runtime_available");
}
const privateConfig = () => ({
  gateway: origin,
  agentId: report.agent_id,
  cookies: originalCookies,
  signal: abort.signal,
});
const view = (page, sessionId) =>
  readC4View(page.context(), {
    gateway: origin,
    agentId: report.agent_id,
    sessionId,
    frames,
  });
async function prompt(page, text, options = {}) {
  const receipt = {},
    result = { receipt };
  report.prompt_receipts.push(receipt);
  report.prompt_results.push(result);
  const pending = scope.track(
    (async () => {
      const response = await page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /^\/api\/app\/workspace\/v1\/agents\/[^/]+\/sessions\/[^/]+\/prompts$/u.test(
            new URL(response.url()).pathname,
          ),
      );
      return captureC4PromptReceipt(page, response, privateConfig(), receipt);
    })(),
  );
  await page.getByRole("combobox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await pending;
  assert.deepEqual(
    receipt.request.body.prompt,
    [{ type: "text", text }],
    "original Development Prompt changed",
  );
  const completed = await until(
    page,
    async () => {
      const allow = page.getByRole("button", {
        name: "Allow once",
        exact: true,
      });
      if (await allow.isVisible()) await allow.click();
      return developmentCompletedTurn(
        await view(page, receipt.sessionId),
        receipt,
      );
    },
    "original Bridge Prompt completion",
  );
  Object.assign(result, structuredClone(completed));
  const detail = await readDevelopmentTurn(
    privateConfig(),
    receipt.sessionId,
    completed.turn,
    result,
  );
  result.answer = assertDevelopmentTurnContent(receipt, detail, options);
  await until(
    page,
    () => workspaceLocation(page.url()).sessionId === receipt.sessionId,
    "original Session URL",
  );
  await until(
    page,
    () =>
      page.getByRole("combobox", { name: "Message", exact: true }).isEnabled(),
    "Composer ready",
  );
  const exchange = page
    .locator(".conversation-turn")
    .filter({ has: page.getByText(text, { exact: true }) });
  await until(
    page,
    async () =>
      (await exchange.count()) === 1 &&
      (await exchange
        .locator(".message-answer .message-content")
        .isVisible()) &&
      Boolean(
        (
          await exchange
            .locator(".message-answer .message-content")
            .textContent()
        )?.trim(),
      ),
    "visible original turn answer",
  );
  if (options.marker)
    assert(
      (
        await exchange.locator(".message-answer .message-content").textContent()
      ).includes(options.marker),
      "Visible original reply differs from the file marker",
    );
  if (options.requireTools) {
    const show = exchange.getByRole("button", {
      name: "Show process",
      exact: true,
    });
    assert.equal(
      await show.getAttribute("aria-expanded"),
      "false",
      "Process must start collapsed",
    );
    await show.click();
    await until(
      page,
      async () => {
        if (await exchange.locator(".tool-activity.tool-completed").count())
          return true;
        const more = exchange.getByRole("button", {
          name: "Load more process",
          exact: true,
        });
        if ((await more.isVisible()) && (await more.isEnabled()))
          await more.click();
        return false;
      },
      "completed Tool activity on original turn",
    );
    assert.equal(
      await exchange.locator(".tool-activity[open]").count(),
      0,
      "Tools must start collapsed",
    );
    await exchange
      .getByRole("button", { name: "Hide process", exact: true })
      .click();
  }
  report.last_prompt = {
    stop_reason: completed.operation.stopReason,
    operation_id: completed.operation.operationId,
    run_id: completed.operation.runId,
  };
  return result;
}
async function history(page) {
  const location = workspaceLocation(page.url());
  assert.equal(location.agentId, report.agent_id);
  assert.equal(location.sessionId, report.session_id);
  const current = await view(page, location.sessionId);
  assert.equal(current.selectedView.historyState, "ready");
  assert.equal(
    current.selectedView.olderTurnsCursor,
    null,
    "Development Session must retain all three original turns",
  );
  const turns = [];
  for (const turn of current.selectedView.turns) {
    const detail = await readDevelopmentTurn(
      privateConfig(),
      location.sessionId,
      turn,
    );
    turns.push({
      turnId: turn.turnId,
      outcome: turn.outcome,
      content: detail.content,
      process: detail.process.map(({ contentCursor, ...item }) => item),
      processVersion: turn.processVersion,
      processCount: turn.processCount,
    });
  }
  return {
    sessionId: location.sessionId,
    turns,
    visible: await page
      .locator(
        ".message-user .message-content, .message-answer .message-content",
      )
      .allTextContents(),
  };
}
try {
  await runDevelopmentBrowserScope(
    {
      launch: () =>
        chromium.launch({
          headless: true,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
        }),
      signal: abort.signal,
      report,
      preserve(value) {
        value.browser_errors = errors.length;
        if (value.status === "failed") value.failed_stage = stage;
        write("report.json", value);
      },
    },
    async (activeScope) => {
      scope = activeScope;
      const { context } = scope;
      const page = await context.newPage();
      track(page);
      stage = "login";
      const signedIn = await login(page);
      originalCookies = structuredClone(await context.cookies());
      report.original_login = {
        principal: structuredClone(signedIn.principal),
        cookies: originalCookies,
      };
      report.checks.push("browser_admin_login");
      if (values.agent) report.agent_id = values.agent;
      else await initialize(page, signedIn.principal);

      stage = "console_chat_link";
      await page.goto(`${origin}/#agents/${report.agent_id}`);
      const link = page.getByRole("link", { name: "Open chat", exact: true });
      const href = await link.getAttribute("href");
      assert.equal(
        workspaceLocation(new URL(href, origin)).agentId,
        report.agent_id,
      );
      const popup = scope.track(page.waitForEvent("popup"));
      await link.click();
      const chat = await popup;
      track(chat);
      await chat
        .getByRole("combobox", { name: "Message", exact: true })
        .waitFor();
      await until(
        chat,
        () =>
          chat
            .getByRole("combobox", { name: "Message", exact: true })
            .isEnabled(),
        "Chat ready",
      );
      report.checks.push("console_open_chat_same_agent");
      stage = "greeting";
      const greeting = await prompt(chat, "\u4f60\u597d");
      report.greeting_blocks = greeting.content.finalResponse.length;
      report.checks.push("real_deepseek_greeting");
      report.session_id = workspaceLocation(chat.url()).sessionId;
      assert(report.session_id);
      console.log(
        JSON.stringify({
          stage,
          status: "passed",
          session: report.session_id,
          blocks: report.greeting_blocks,
        }),
      );

      stage = "runtime_tools";
      const marker = `ANTNEST-ACCEPTANCE-${Date.now()}`;
      report.workspace_marker = marker;
      report.workspace_file = "/workspace/acceptance-note.txt";
      await prompt(
        chat,
        `Write exactly ${marker} to /workspace/acceptance-note.txt, then read the file to verify it. Use the actual tools, not instructions for me. Report the content you read.`,
        { requireTools: true, marker },
      );
      report.checks.push("real_runtime_tools_and_collapsed_activity");
      report.workspace_url = chat.url();
      await chat.screenshot({
        path: `${output}/chat-desktop.png`,
        fullPage: true,
      });

      stage = "history_restore";
      const content = (report.history_before = await history(chat));
      const requestCount = requests.length;
      await chat.reload();
      await chat
        .getByRole("combobox", { name: "Message", exact: true })
        .waitFor();
      await until(
        chat,
        () =>
          chat
            .getByRole("combobox", { name: "Message", exact: true })
            .isEnabled(),
        "Restored chat ready",
      );
      const restoredHistory = (report.history_after = await history(chat));
      assertDevelopmentReload(
        content,
        restoredHistory,
        requestCount,
        requests.length,
      );
      report.checks.push("server_history_replayed_without_resubmission");
      stage = "restored_runtime_tools";
      await prompt(
        chat,
        "Read /workspace/acceptance-note.txt again with the actual tool and report its content. Do not rewrite it.",
        { requireTools: true, marker },
      );
      report.checks.push("real_tool_execution_after_history_restore");
      stage = "mobile_layout";
      await chat.setViewportSize({ width: 390, height: 844 });
      if (await chat.locator(".sidebar-open").count())
        await chat.locator(".sidebar-close").click();
      await chat.locator(".sidebar").waitFor({ state: "hidden" });
      assert(
        await chat.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "Mobile horizontal overflow",
      );
      await chat.screenshot({
        path: `${output}/chat-mobile.png`,
        fullPage: true,
      });
      report.checks.push("mobile_chat_no_horizontal_overflow");

      stage = "agent_chooser";
      await chat.goto(`${origin}/workspace/`);
      await chat
        .getByRole("searchbox", { name: "Find a workspace", exact: true })
        .waitFor();
      assert.equal(new URL(chat.url()).pathname, "/workspace/");
      report.checks.push("workspace_requires_explicit_agent_choice");
      assert.equal(errors.length, 0, "Browser errors detected");
      stage = "chat_trace";
      const secrets = parseEnv(readFileSync(values["secret-file"], "utf8"));
      report.chat_traces = await collectDevelopmentChatTraces({
        jaeger: values.jaeger,
        sessionId: report.session_id,
        receipts: report.prompt_receipts,
        operations: report.prompt_results.map((result) => result.operation),
        signal: abort.signal,
        output,
        secrets: [
          settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
          secrets.DEEPSEEK_API_KEY,
        ],
      });
      report.checks.push("gateway_acp_model_runtime_trace_ancestry");
      assert.equal(
        requests.length,
        3,
        "Development must send exactly three Prompts",
      );
      assert.equal(report.prompt_receipts.length, 3);
    },
  );
} catch (error) {
  process.exitCode = 1;
  console.error(
    JSON.stringify({
      status: "failed",
      stage,
      error_type: error.name,
      evidence: output,
    }),
  );
} finally {
  for (const [name, handler] of handlers) process.removeListener(name, handler);
  console.log(
    JSON.stringify({
      status: report.status,
      agent_id: report.agent_id,
      session_id: report.session_id,
      checks: report.checks,
      evidence: output,
    }),
  );
}
