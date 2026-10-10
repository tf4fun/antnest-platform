import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import { gatewayBrowserRequest } from "../../support/gateway-browser-request.mjs";
import { durablePath } from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";

// Explicitly opt-in: adds Pro if absent and sends two real model prompts.
const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    "env-file": { type: "string", default: ".env" },
    "confirm-development": { type: "boolean", default: false },
    "real-models": { type: "boolean", default: false },
  },
});
values["env-file"] = durablePath(values["env-file"]);
assert(
  values["confirm-development"] && values["real-models"],
  "Explicit development and real-model approval flags required",
);
const origin = new URL(values.gateway).origin;
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const settings = parseEnv(readFileSync(values["env-file"], "utf8"));
const output = "artifacts/verification/model-selection-acceptance";
durablePath(output);
await mkdir(output, { recursive: true });
const report = { status: "running", gateway: origin, models: [], checks: [] };
const browser = await chromium.launch({ headless: true });
let stage = "login";
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
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
  async function read(path) {
    const response = await gatewayBrowserRequest(page.context(), origin + path);
    assert.equal(response.status(), 200, path);
    return response.json();
  }
  async function ready() {
    await page.waitForFunction(
      () => document.querySelector("textarea")?.disabled === false,
    );
  }
  async function choose(name, optionName) {
    await page.getByRole("combobox", { name, exact: true }).click();
    await page.getByRole("option", { name: optionName }).click();
    await ready();
  }
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
  const login = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/session/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  assert.equal((await login).status(), 200);
  stage = "add_model";
  const providers = await read("/api/admin/provider-connections");
  const provider = providers.items.find(
    (p) => p.provider_key === "deepseek" && p.enabled,
  );
  assert(provider, "Enabled DeepSeek connection required");
  let models = (await read("/api/admin/model-profiles")).items;
  if (
    !models.some(
      (m) =>
        m.provider_connection_id === provider.connection_id &&
        m.model.model === "deepseek-v4-pro",
    )
  ) {
    await page.goto(origin + "/#models");
    await page
      .getByRole("list", { name: "Model providers" })
      .getByRole("button", { name: new RegExp(provider.display_name) })
      .click();
    await page.getByRole("button", { name: "Add model", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add model" });
    await dialog
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption("deepseek-v4-pro");
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/model-profiles") &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Add model", exact: true })
      .click();
    assert.equal((await saved).status(), 201);
    models = (await read("/api/admin/model-profiles")).items;
  }
  const selected = ["deepseek-v4-flash", "deepseek-v4-pro"].map((id) => {
    const model = models.find(
      (m) =>
        m.provider_connection_id === provider.connection_id &&
        m.model.model === id &&
        m.enabled,
    );
    assert(model, `${id} is not enabled`);
    return model;
  });
  const bootstrap = await read("/api/app/bootstrap");
  const agent = bootstrap.agents.find(
    (a) =>
      a.lifecycle_state === "created" &&
      a.activation_state === "enabled" &&
      a.runtime_state === "available",
  );
  assert(agent, "Available Agent required");
  report.agent_id = agent.agent_id;
  stage = "automatic_configuration";
  await page.goto(`${origin}/workspace/${encodeURIComponent(agent.agent_id)}/`);
  await ready();
  report.session_id = workspaceLocation(page.url()).sessionId;
  assert(report.session_id, "Automatic Session URL missing");
  assert.equal(
    await page
      .getByRole("button", { name: "Conversation settings", exact: true })
      .count(),
    0,
  );
  assert.equal(
    frames.filter(
      (f) => f.event === "framesent" && f.value.method === "session/new",
    ).length,
    1,
  );
  assert.equal(
    frames.filter((f) => f.value.method === "session/prompt").length,
    0,
  );
  for (const model of selected) {
    stage = model.model.model;
    await choose("Model", new RegExp(`^${model.display_name}`));
    await choose("Thinking", /^Off/);
    const start = frames.length;
    await page
      .getByRole("combobox", { name: "Message", exact: true })
      .fill("请用一句简短中文打招呼，不要调用工具。");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const deadline = Date.now() + 120000;
    let reply;
    while (Date.now() < deadline) {
      const request = frames
        .slice(start)
        .find(
          (f) => f.event === "framesent" && f.value.method === "session/prompt",
        );
      reply =
        request &&
        frames
          .slice(start)
          .find(
            (f) =>
              f.event === "framereceived" && f.value.id === request.value.id,
          );
      if (reply) break;
      await page.waitForTimeout(250);
    }
    assert(reply, "Prompt response timed out");
    assert(!reply.value.error, `ACP error: ${reply.value.error?.code}`);
    assert.equal(reply.value.result.stopReason, "end_turn");
    const content = frames
      .slice(start)
      .filter(
        (f) =>
          f.event === "framereceived" &&
          f.value.params?.update?.sessionUpdate === "agent_message_chunk",
      )
      .map((f) => f.value.params.update.content?.text ?? "")
      .join("");
    assert(content.trim(), "Model returned no visible reply");
    await ready();
    report.models.push({
      model: model.model.model,
      model_profile_id: model.model_profile_id,
      response_characters: content.length,
      stop_reason: "end_turn",
    });
    console.log(
      JSON.stringify({
        stage,
        status: "passed",
        response_characters: content.length,
      }),
    );
  }
  stage = "replay_and_layout";
  await page.reload();
  await ready();
  assert.equal(workspaceLocation(page.url()).sessionId, report.session_id);
  assert.match(
    await page
      .getByRole("combobox", { name: "Model", exact: true })
      .innerText(),
    /Pro/,
  );
  assert.equal(
    frames.filter(
      (f) => f.event === "framesent" && f.value.method === "session/new",
    ).length,
    1,
  );
  assert.equal(
    frames.filter(
      (f) => f.event === "framesent" && f.value.method === "session/prompt",
    ).length,
    2,
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    const box = await page.locator(".config-popover").boundingBox();
    assert(
      box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width,
      "Model menu leaves viewport",
    );
    await page.screenshot({ path: `${output}/model-menu-${width}.png` });
    await page.getByRole("searchbox", { name: "Search Model" }).press("Escape");
    await page.screenshot({ path: `${output}/chat-${width}.png` });
  }
  assert.deepEqual(errors, []);
  report.checks = [
    "console_model_creation",
    "automatic_acp_session",
    "two_real_model_responses",
    "reload_keeps_model",
    "no_prompt_replay",
    "desktop_mobile_menu_bounds",
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
  await browser.close();
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
}
