import { durablePath } from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";

// Opt-in development acceptance: saves OpenRouter, rebuilds one Agent, sends
// three short real prompts, and restores Provider availability in finally.
const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    "env-file": { type: "string", default: ".env" },
    "secret-file": { type: "string", default: "../.secret" },
    "confirm-development": { type: "boolean", default: false },
    "real-models": { type: "boolean", default: false },
  },
});
values["env-file"] = durablePath(values["env-file"]);
values["secret-file"] = durablePath(values["secret-file"]);
assert(
  values["confirm-development"] && values["real-models"],
  "Explicit development and real-model flags required",
);
const origin = new URL(values.gateway).origin;
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const env = parseEnv(readFileSync(values["env-file"], "utf8"));
const secrets = parseEnv(readFileSync(values["secret-file"], "utf8"));
assert(secrets.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is required");
const output = "artifacts/verification/provider-failover-acceptance";
durablePath(output);
await mkdir(output, { recursive: true });
const report = { status: "running", checks: [], responses: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const restore = new Map();
let stage = "login";
async function read(path) {
  const response = await context.request.get(origin + path);
  assert.equal(response.status(), 200, path);
  return response.json();
}
async function command(path, data, method = "POST") {
  const csrf = (await context.cookies(origin)).find(
    (cookie) => cookie.name === "antnest_csrf",
  )?.value;
  const response = await context.request.fetch(origin + path, {
    method,
    data,
    headers: {
      "Idempotency-Key": randomUUID(),
      "X-Antnest-CSRF-Token": decodeURIComponent(csrf ?? ""),
      Origin: origin,
    },
  });
  assert(response.ok(), `${method} ${path}: HTTP ${response.status()}`);
  return response.json();
}
async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function available(connection, enabled) {
  const path = `/api/admin/provider-connections/${connection.connection_id}`;
  const current = await read(path);
  if (!restore.has(current.connection_id))
    restore.set(current.connection_id, current.enabled);
  if (current.enabled !== enabled)
    await command(
      path + "/availability",
      { expected_enabled: current.enabled, enabled },
      "PUT",
    );
  await until(async () => {
    const { synchronization: status } = await read(
      "/api/admin/execution-synchronization",
    );
    return status && status.applied_revision === status.revision;
  }, "execution publication");
}
try {
  await page.goto(origin);
  await page
    .locator('[name="organization_slug"]')
    .fill(env.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG);
  await page.locator('[name="email"]').fill(env.ANTNEST_BOOTSTRAP_ADMIN_EMAIL);
  await page
    .locator('[name="password"]')
    .fill(env.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD);
  const login = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/session/login") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  assert.equal((await login).status(), 200);
  stage = "provider_setup";
  let connections = (await read("/api/admin/provider-connections")).items;
  const primary = connections.find(
    (item) => item.provider_key === "deepseek" && item.enabled,
  );
  assert(primary, "Enabled DeepSeek required");
  let router = connections.find((item) => item.provider_key === "openrouter");
  const catalog = (await read("/api/admin/model-catalog")).providers.find(
    (item) => item.provider_key === "openrouter",
  );
  assert(catalog, "Console OpenRouter preset missing");
  const preset = catalog.models.find(
    (item) => item.model_id === "openai/gpt-4o-mini",
  );
  assert(preset);
  const modelInput = {
    display_name: preset.display_name,
    model: {
      model: preset.model_id,
      context_window: preset.context_window,
      max_output_tokens: preset.max_output_tokens,
      supports_images: preset.supports_images,
      pricing: preset.pricing,
    },
  };
  if (!router) {
    await command("/api/admin/provider-connections", {
      provider_key: "openrouter",
      display_name: "OpenRouter",
      base_url: catalog.base_url,
      credential: { method: "api_key", api_key: secrets.OPENROUTER_API_KEY },
      models: [modelInput],
    });
    connections = (await read("/api/admin/provider-connections")).items;
    router = connections.find((item) => item.provider_key === "openrouter");
  }
  assert(router);
  await available(router, true);
  let models = (await read("/api/admin/model-profiles")).items;
  if (
    !models.some(
      (item) =>
        item.provider_connection_id === router.connection_id &&
        item.model.model === preset.model_id,
    )
  ) {
    await command("/api/admin/model-profiles", {
      provider_connection_id: router.connection_id,
      ...modelInput,
    });
    models = (await read("/api/admin/model-profiles")).items;
  }
  const backup = models.find(
    (item) =>
      item.provider_connection_id === router.connection_id &&
      item.model.model === preset.model_id &&
      item.enabled,
  );
  assert(backup);
  const agents = (await read("/api/admin/agents")).items;
  let agent = agents.find(
    (item) =>
      item.lifecycle_state === "created" &&
      item.activation_state === "enabled" &&
      item.runtime_state === "available",
  );
  assert(agent, "Available development Agent required");
  agent = await read(`/api/admin/agents/${agent.agent_id}`);
  let template = await read(
    `/api/admin/templates/${agent.configuration.template.template_id}`,
  );
  const defaultModel = models.find(
    (item) =>
      item.model_profile_id === template.model_profile_id &&
      item.provider_connection_id === primary.connection_id,
  );
  assert(defaultModel, "Template must default to DeepSeek");
  stage = "template_and_rebuild";
  if (!template.fallback_model_profile_ids?.includes(backup.model_profile_id)) {
    template = await command(
      `/api/admin/templates/${template.template_id}/revisions`,
      {
        name: template.name,
        model_profile_id: template.model_profile_id,
        fallback_model_profile_ids: [
          ...(template.fallback_model_profile_ids ?? []),
          backup.model_profile_id,
        ],
        system_prompt: template.system_prompt,
        max_model_requests: template.max_model_requests,
        runtime: {
          image_ref: template.runtime.image_ref,
          resources: template.runtime.resources,
          mcp_servers: template.runtime.mcp_servers ?? [],
        },
      },
    );
  }
  if (agent.configuration.template.revision !== template.revision) {
    const operation = await command(
      `/api/admin/agents/${agent.agent_id}/rebuild`,
      {
        template_id: template.template_id,
        template_revision: template.revision,
      },
    );
    await until(
      async () => {
        const current = await read(
          `/api/admin/operations/${operation.request_id}`,
        );
        assert(
          current.state !== "failed",
          `Agent rebuild failed: ${current.error_code}`,
        );
        const state = await read(`/api/admin/agents/${agent.agent_id}`);
        return (
          state.runtime_state === "available" &&
          state.configuration?.template.revision === template.revision &&
          !state.active_operation_request_id
        );
      },
      "Agent rebuild",
      240000,
    );
  }
  report.agent_id = agent.agent_id;
  await page.goto(origin + `/#templates/${template.template_id}`);
  await page
    .getByRole("button", { name: "Create revision", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create template revision" });
  await dialog
    .getByRole("button", { name: `Remove ${backup.display_name}` })
    .waitFor();
  await page.screenshot({ path: `${output}/template-backups.png` });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const frames = [];
  const errors = [];
  page.on("pageerror", () => errors.push("page error"));
  page.on("websocket", (socket) => {
    for (const event of ["framesent", "framereceived"])
      socket.on(event, ({ payload }) => {
        try {
          frames.push({ event, value: JSON.parse(String(payload)) });
        } catch {
          errors.push("invalid ACP frame");
        }
      });
  });
  const ready = () =>
    page.waitForFunction(
      () => document.querySelector("textarea")?.disabled === false,
    );
  async function choose(option) {
    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: option }).click();
    await ready();
  }
  async function prompt(expectedModel) {
    const start = frames.length;
    const answers = page.locator(".message-answer .message-content");
    const previousAnswers = await answers.count();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("请用一句简短中文打招呼，不要调用工具。");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const reply = await until(() => {
      const request = frames
        .slice(start)
        .find(
          (frame) =>
            frame.event === "framesent" &&
            frame.value.method === "session/prompt",
        );
      return (
        request &&
        frames
          .slice(start)
          .find(
            (frame) =>
              frame.event === "framereceived" &&
              frame.value.id === request.value.id,
          )
      );
    }, "real model response");
    assert(!reply.value.error, `ACP error: ${reply.value.error?.code}`);
    assert.equal(reply.value.result.stopReason, "end_turn");
    const sent = frames
      .slice(start)
      .find(
        (frame) =>
          frame.event === "framesent" &&
          frame.value.method === "session/prompt",
      );
    const sessionID = sent?.value.params?.sessionId;
    assert.equal(
      typeof sessionID,
      "string",
      "Prompt must identify its Session",
    );
    report.session_id ??= sessionID;
    assert.equal(
      report.session_id,
      sessionID,
      "Provider switch must keep the same Session",
    );
    const streamed = frames
      .slice(start)
      .filter(
        (frame) =>
          frame.value.params?.update?.sessionUpdate === "agent_message_chunk",
      )
      .map((frame) => frame.value.params.update.content?.text ?? "")
      .join("");
    assert(streamed.trim(), "No ACP message update");
    await ready();
    await until(
      async () => (await answers.count()) === previousAnswers + 1,
      "one new rendered reply",
    );
    const content = await answers.last().innerText();
    assert(content.trim(), "New model reply is blank in the UI");
    const audits = await read(
      `/api/admin/execution-audits?session_id=${encodeURIComponent(report.session_id)}&limit=20`,
    );
    const fresh = audits.items.filter(
      (item) =>
        !report.responses.some((previous) => previous.run_id === item.run_id),
    );
    assert.equal(
      fresh.length,
      1,
      "Prompt must produce exactly one new audit Run",
    );
    const audit = await read(`/api/admin/execution-audits/${fresh[0].run_id}`);
    assert.equal(audit.terminal_class, "completed");
    assert.equal(
      audit.execution_snapshot.modelProfileId,
      expectedModel.model_profile_id,
    );
    assert.equal(
      audit.execution_snapshot.providerConnectionId,
      expectedModel.provider_connection_id,
    );
    assert.equal(
      audit.execution_snapshot.executionSpec.model.model,
      expectedModel.model.model,
    );
    report.responses.push({
      run_id: audit.run_id,
      model: expectedModel.model.model,
      provider_connection_id: audit.execution_snapshot.providerConnectionId,
      response_characters: content.length,
    });
    console.log(
      JSON.stringify({
        stage,
        status: "passed",
        response_characters: content.length,
      }),
    );
  }
  await page.goto(`${origin}/workspace/?agent=${agent.agent_id}`);
  await ready();
  if (
    await page.getByRole("combobox", { name: "Thinking", exact: true }).count()
  ) {
    await page.getByRole("combobox", { name: "Thinking", exact: true }).click();
    await page.getByRole("option", { name: /^Off/ }).click();
    await ready();
  }
  stage = "default_deepseek";
  await prompt(defaultModel);
  stage = "automatic_openrouter";
  await available(primary, false);
  await page
    .locator(".session-settings-notice")
    .filter({ hasText: "Switched to OpenRouter" })
    .waitFor();
  assert.match(
    await page
      .getByRole("combobox", { name: "Model", exact: true })
      .innerText(),
    /GPT-4o mini/,
  );
  await prompt(backup);
  await page.reload();
  await ready();
  await page
    .locator(".session-settings-notice")
    .filter({ hasText: "Switched to OpenRouter" })
    .waitFor();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Horizontal overflow",
    );
    await page.screenshot({ path: `${output}/fallback-${width}.png` });
  }
  stage = "manual_openrouter";
  await available(primary, true);
  await choose(new RegExp(`^${backup.display_name}`));
  await prompt(backup);
  stage = "no_available_provider";
  await available(primary, false);
  await available(router, false);
  await page.waitForFunction(
    () =>
      document.querySelector('button[aria-label="Send message"]')?.disabled ===
      true,
  );
  await page
    .locator(".session-settings-notice")
    .filter({ hasText: "No configured Provider" })
    .waitFor();
  assert.equal(
    frames.filter(
      (frame) =>
        frame.event === "framesent" && frame.value.method === "session/prompt",
    ).length,
    3,
    "Unexpected prompt replay",
  );
  assert.deepEqual(errors, []);
  report.checks = [
    "console_ordered_backups",
    "referenced_provider_disable",
    "three_real_responses",
    "one_new_rendered_reply_per_prompt",
    "idle_live_config_update",
    "fallback_survives_reload",
    "manual_cross_provider_selection",
    "no_available_provider_blocks_send",
    "no_prompt_replay",
    "desktop_mobile_layout",
  ];
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.stage = stage;
  console.error(
    JSON.stringify({
      stage,
      error: error instanceof Error ? error.message : "verification failed",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const [id, enabled] of restore) {
    try {
      await available({ connection_id: id }, enabled);
    } catch {
      report.status = "failed";
      report.restore_failed = true;
      process.exitCode = 1;
    }
  }
  await browser.close();
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
}
