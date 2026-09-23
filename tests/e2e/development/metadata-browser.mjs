import {
  readDevelopmentConfiguration,
  writeDevelopmentJSON,
  writeDevelopmentBuffer,
} from "../../support/development-configuration.mjs";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../../services/agent-ui/web/package.json", import.meta.url),
);
const { chromium } = require("playwright");
import { audioData } from "../acp-multimodal/fixtures.mjs";
const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
const { config, settings } = readDevelopmentConfiguration(
  values.config,
  "metadata-browser",
);
process.umask(0o077);
mkdirSync(config.output, { recursive: true, mode: 0o700 });
const prior = {
  agent_id: config.agentId,
  session_id: config.sessionId,
  workspace_url: config.workspaceUrl,
};
const origin = config.gateway;
const report = { status: "running", session_id: prior.session_id, checks: [] };
const records = new WeakMap();
let browser;
let errors = 0;
let interruption;
const checkInterrupted = () => {
  if (interruption) throw interruption;
};
const interrupted = () => {
  interruption ??= Object.assign(new Error("metadata browser interrupted"), {
    name: "Interrupted",
  });
  report.status = "failed";
  report.error_type = "Interrupted";
  process.exitCode = 1;
  void browser?.close().catch(() => {});
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
const deadline = setTimeout(interrupted, 180000);
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(check, label, limit = 20000) {
  checkInterrupted();
  const end = Date.now() + limit;
  while (Date.now() < end) {
    checkInterrupted();
    const value = await check();
    if (value) return value;
    await pause();
  }
  throw new Error(`${label}: deadline`);
}
function track(page) {
  const frames = [];
  records.set(page, frames);
  page.setDefaultTimeout(20000);
  page.on("pageerror", () => errors++);
  page.on("websocket", (socket) => {
    for (const event of ["framesent", "framereceived"])
      socket.on(event, ({ payload }) => {
        try {
          frames.push({ event, value: JSON.parse(String(payload)) });
        } catch {
          errors++;
        }
      });
  });
  return page;
}
const input = (page) =>
  page.getByRole("textbox", { name: "Message", exact: true });
const ready = (page) => until(() => input(page).isEnabled(), "composer");
const info = (page) =>
  records
    .get(page)
    .findLast(
      ({ value }) =>
        value.method === "session/update" &&
        value.params?.sessionId === prior.session_id &&
        value.params.update.sessionUpdate === "session_info_update",
    )?.value.params.update;
const visible = async (page, expected) =>
  until(async () => {
    const row = page.locator(".conversation-option.active");
    return (
      (await row.locator("strong").textContent()) === expected.title &&
      (await row.locator("time").getAttribute("datetime")) ===
        expected.updatedAt
    );
  }, "visible metadata");
async function prompt(page, text) {
  const start = records.get(page).length;
  await input(page).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  return until(
    () => {
      const fresh = records.get(page).slice(start);
      const request = fresh.find(
        (item) =>
          item.event === "framesent" && item.value.method === "session/prompt",
      );
      return (
        request &&
        fresh.find(
          (item) =>
            item.event === "framereceived" &&
            item.value.id === request.value.id,
        )?.value
      );
    },
    "prompt response",
    120000,
  );
}
try {
  browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  checkInterrupted();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const login = await context.request.post(`${origin}/api/session/login`, {
    data: {
      organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
      email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
      password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  assert.equal(login.status(), 200);
  const page = track(await context.newPage());
  await page.goto(prior.workspace_url);
  await ready(page);
  const observer = track(await context.newPage());
  await observer.goto(prior.workspace_url);
  await ready(observer);
  const previous = await until(() => info(observer), "initial metadata");
  const reply = await prompt(
    page,
    "Reply with exactly DEPLOYMENT-METADATA-OK. Do not use tools.",
  );
  assert.equal(reply.result?.stopReason, "end_turn");
  await ready(page);
  await until(
    () =>
      info(page)?.updatedAt !== previous.updatedAt &&
      info(page)?.updatedAt === info(observer)?.updatedAt,
    "observer metadata",
  );
  const metadata = info(page);
  assert.deepEqual(info(observer), metadata);
  await visible(page, metadata);
  await visible(observer, metadata);
  const content = await page.locator(".message-content").allTextContents();
  assert(content.some((text) => text.includes("DEPLOYMENT-METADATA-OK")));
  records.get(observer).length = 0;
  await observer.reload();
  await ready(observer);
  const listed = records
    .get(observer)
    .flatMap(({ value }) => value.result?.sessions ?? [])
    .find((session) => session.sessionId === prior.session_id);
  assert(listed);
  assert.equal(listed.title, metadata.title);
  assert.equal(listed.updatedAt, metadata.updatedAt);
  assert.deepEqual(info(observer), metadata);
  await visible(observer, metadata);
  assert.deepEqual(
    await observer.locator(".message-content").allTextContents(),
    content,
  );
  assert.equal(
    records
      .get(observer)
      .filter(
        ({ event, value }) =>
          event === "framesent" && value.method === "session/prompt",
      ).length,
    0,
  );
  report.metadata = {
    title: metadata.title,
    before: previous.updatedAt,
    after: metadata.updatedAt,
    observers: 2,
    list_reload: "matched",
    reload_prompt_count: 0,
  };
  report.checks.push("two_page_metadata_list_reload_history_without_replay");
  writeDevelopmentBuffer(
    config,
    "metadata-desktop.png",
    await observer.screenshot({ fullPage: true }),
  );
  const negative = track(await context.newPage());
  await negative.goto(`${origin}/workspace/?agent=${prior.agent_id}`);
  await ready(negative);
  await negative.getByLabel("File attachments", { exact: true }).setInputFiles({
    name: "unsupported.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from(audioData, "base64"),
  });
  const rejected = await prompt(negative, "Deployment unsupported audio check");
  assert.equal(rejected.error?.data?.code, "model_unsupported_content");
  const alert = negative.getByRole("alert").filter({
    hasText: "The selected model does not support this attachment type.",
  });
  await alert.waitFor();
  await ready(negative);
  report.rejected_session_id = new URL(negative.url()).searchParams.get(
    "session",
  );
  assert(report.rejected_session_id);
  report.rejection = {
    code: rejected.error.code,
    error_class: rejected.error.data.code,
    message: await alert.textContent(),
  };
  writeDevelopmentBuffer(
    config,
    "capability-rejection.png",
    await negative.screenshot({ fullPage: true }),
  );
  report.checks.push(
    "unsupported_audio_actionable_error_and_composer_recovery",
  );
  assert.equal(errors, 0);
  checkInterrupted();
  report.status = "passed";
} catch (error) {
  error = interruption ?? error;
  report.status = "failed";
  report.error_type = error.name;
  report.assertion =
    error.name === "AssertionError" ? error.message.split("\n")[0] : undefined;
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try {
    await browser?.close();
  } catch (error) {
    report.status = "failed";
    report.error_type ??= error.name;
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    report.browser_errors = errors;
    writeDevelopmentJSON(config, "metadata-report.json", report);
    console.log(JSON.stringify(report));
  }
}
