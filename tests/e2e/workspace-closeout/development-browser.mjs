import { durablePath } from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { collectChatTraces } from "./chat-trace.mjs";

// Real browser, Gateway, services, Runtime and model. Retains acceptance data.
const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    "env-file": { type: "string", default: ".env" },
    "secret-file": { type: "string", default: "../.secret" },
    agent: { type: "string" },
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
const output = "artifacts/verification/development-acceptance";
durablePath(output);
await mkdir(output, { recursive: true });
const report = { status: "running", gateway: origin, traces: {}, checks: [] };
let browser;
let stage = "launch";
const errors = [];
const frames = [];
function track(page) {
  page.setDefaultTimeout(20000);
  page.on("pageerror", () => errors.push("browser page error"));
  page.on("websocket", (socket) => {
    for (const event of ["framesent", "framereceived"])
      socket.on(event, ({ payload }) => {
        try {
          frames.push({ event, value: JSON.parse(String(payload)) });
        } catch {
          errors.push("invalid WebSocket JSON");
        }
      });
  });
}
async function mutation(page, path, status, action, name) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === "POST",
  );
  await action();
  const response = await pending;
  assert.equal(response.status(), status, `${name}: HTTP status`);
  report.traces[name] = response.headers()["x-antnest-trace-id"];
  return response.json();
}
async function json(page, path) {
  const response = await page.request.get(origin + path);
  assert.equal(response.status(), 200, `${path}: HTTP status`);
  return response.json();
}
async function until(page, check, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
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
  for (const checkbox of await dialog.getByRole("checkbox").all())
    await checkbox.uncheck();
  await dialog
    .getByRole("checkbox", { name: "DeepSeek V4 Flash", exact: true })
    .check();
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
async function prompt(page, text) {
  const start = frames.length;
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const result = await until(
    page,
    async () => {
      const records = frames.slice(start);
      const request = records.find(
        ({ event, value }) =>
          event === "framesent" && value.method === "session/prompt",
      );
      const reply =
        request &&
        records.find(
          ({ event, value }) =>
            event === "framereceived" && value.id === request.value.id,
        );
      const allow = page.getByRole("button", {
        name: "Allow once",
        exact: true,
      });
      if (await allow.isVisible()) await allow.click();
      return reply?.value;
    },
    "ACP prompt completion",
  );
  report.last_prompt = {
    error_code: result.error?.code,
    error_class: result.error?.data?.code,
    stop_reason: result.result?.stopReason,
  };
  assert(!result.error, "ACP prompt returned an error");
  assert.equal(result.result.stopReason, "end_turn");
  await until(
    page,
    () =>
      page.getByRole("textbox", { name: "Message", exact: true }).isEnabled(),
    "Composer ready",
  );
  const updates = frames
    .slice(start)
    .filter(
      ({ event, value }) =>
        event === "framereceived" && value.method === "session/update",
    );
  const textChunks = updates.filter(
    ({ value }) => value.params.update.sessionUpdate === "agent_message_chunk",
  );
  assert(textChunks.length > 0, "Missing assistant message updates");
  const visible = await page
    .locator(".message-assistant .message-content")
    .allTextContents();
  assert(
    visible.some((content) => content.trim()),
    "Empty assistant message on screen",
  );
  return { updates, textChunks };
}
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  track(page);
  stage = "login";
  const signedIn = await login(page);
  report.checks.push("browser_admin_login");
  if (values.agent) report.agent_id = values.agent;
  else await initialize(page, signedIn.principal);

  stage = "console_chat_link";
  await page.goto(`${origin}/#agents/${report.agent_id}`);
  const link = page.getByRole("link", { name: "Open chat", exact: true });
  const href = await link.getAttribute("href");
  assert.equal(
    new URL(href, origin).searchParams.get("agent"),
    report.agent_id,
  );
  const popup = page.waitForEvent("popup");
  await link.click();
  const chat = await popup;
  track(chat);
  await chat.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await until(
    chat,
    () =>
      chat.getByRole("textbox", { name: "Message", exact: true }).isEnabled(),
    "Chat ready",
  );
  report.checks.push("console_open_chat_same_agent");
  stage = "greeting";
  const greeting = await prompt(chat, "\u4f60\u597d");
  report.greeting_chunks = greeting.textChunks.length;
  report.checks.push("real_deepseek_greeting");
  report.session_id = new URL(chat.url()).searchParams.get("session");
  assert(report.session_id);
  console.log(
    JSON.stringify({
      stage,
      status: "passed",
      session: report.session_id,
      chunks: report.greeting_chunks,
    }),
  );

  stage = "runtime_tools";
  const marker = `ANTNEST-ACCEPTANCE-${Date.now()}`;
  report.workspace_marker = marker;
  report.workspace_file = "/workspace/acceptance-note.txt";
  const turn = await prompt(
    chat,
    `Write exactly ${marker} to /workspace/acceptance-note.txt, then read the file to verify it. Use the actual tools, not instructions for me. Report the content you read.`,
  );
  const tools = turn.updates.filter(({ value }) =>
    ["tool_call", "tool_call_update"].includes(
      value.params.update.sessionUpdate,
    ),
  );
  assert(
    tools.some(({ value }) => value.params.update.status === "completed"),
    "Missing completed tool update",
  );
  assert(
    await chat.locator(".tool-activity").count(),
    "Tool activity is not visible",
  );
  assert.equal(
    await chat.locator(".tool-activity[open]").count(),
    0,
    "Tools must start collapsed",
  );
  report.checks.push("real_runtime_tools_and_collapsed_activity");
  report.workspace_url = chat.url();
  await chat.screenshot({ path: `${output}/chat-desktop.png`, fullPage: true });

  stage = "history_restore";
  const content = await chat.locator(".message-content").allTextContents();
  const requestCount = frames.filter(
    ({ event, value }) =>
      event === "framesent" && value.method === "session/prompt",
  ).length;
  await chat.reload();
  await chat.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await until(
    chat,
    () =>
      chat.getByRole("textbox", { name: "Message", exact: true }).isEnabled(),
    "Restored chat ready",
  );
  assert.deepEqual(
    await chat.locator(".message-content").allTextContents(),
    content,
    "Restored conversation differs",
  );
  assert.equal(
    frames.filter(
      ({ event, value }) =>
        event === "framesent" && value.method === "session/prompt",
    ).length,
    requestCount,
    "Reload repeated prompt",
  );
  report.checks.push("server_history_replayed_without_resubmission");
  stage = "restored_runtime_tools";
  const restored = await prompt(
    chat,
    "Read /workspace/acceptance-note.txt again with the actual tool and report its content. Do not rewrite it.",
  );
  assert(
    restored.updates.some(
      ({ value }) =>
        ["tool_call", "tool_call_update"].includes(
          value.params.update.sessionUpdate,
        ) && value.params.update.status === "completed",
    ),
    "Restored session did not complete a tool",
  );
  assert(
    (
      await chat
        .locator(".message-assistant .message-content")
        .last()
        .textContent()
    ).includes(marker),
    "Restored tool reply did not match the file marker",
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
  await chat.screenshot({ path: `${output}/chat-mobile.png`, fullPage: true });
  report.checks.push("mobile_chat_no_horizontal_overflow");

  stage = "agent_chooser";
  await chat.goto(`${origin}/workspace/`);
  await chat
    .getByRole("searchbox", { name: "Find an agent", exact: true })
    .waitFor();
  assert.equal(new URL(chat.url()).searchParams.has("agent"), false);
  report.checks.push("workspace_requires_explicit_agent_choice");
  assert.equal(errors.length, 0, "Browser errors detected");
  stage = "chat_trace";
  const secrets = parseEnv(readFileSync(values["secret-file"], "utf8"));
  report.chat_traces = await collectChatTraces({
    jaeger: values.jaeger,
    sessionId: report.session_id,
    secrets: [
      settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
      secrets.DEEPSEEK_API_KEY,
    ],
  });
  report.checks.push("gateway_acp_model_runtime_trace_ancestry");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failed_stage = stage;
  // Playwright errors can contain filled inputs. Do not print full error objects.
  report.error_type = error.name;
  if (error.name === "AssertionError")
    report.assertion = error.message.split("\n", 1)[0];
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.browser_errors = errors.length;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
