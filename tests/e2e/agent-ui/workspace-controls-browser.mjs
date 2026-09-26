import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";

// Runs against the already-created, real authenticated controls fixture.
// All mutations below enter through the rendered composer.
export async function verifyControlsBrowser({
  config,
  fixture,
  signal,
  sessionId,
  reasoning,
  view,
  sessions,
  model,
  output,
}) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const abort = () => void browser.close();
  signal.addEventListener("abort", abort, { once: true });
  const errors = [];
  const commands = [];
  let page;
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const login = await context.request.post(
      `${config.gateway}/api/session/login`,
      {
        data: member,
        headers: { Origin: config.gateway },
      },
    );
    assert.equal(login.status(), 200);
    const track = (target) => {
      target.setDefaultTimeout(25_000);
      target.on("pageerror", (error) => errors.push(error.message));
      target.on("websocket", () => errors.push("unexpected browser WebSocket"));
      return target;
    };
    page = track(await context.newPage());
    const observer = track(await context.newPage());
    const draft = `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/`;
    const input = (target = page) =>
      target.getByRole("combobox", { name: "Message", exact: true });
    const ready = (target = page) =>
      until(
        () => input(target).isEnabled(),
        "controls composer ready",
        signal,
        25_000,
      );
    for (const target of [page, observer]) {
      await target.goto(`${draft}sessions/${encodeURIComponent(sessionId)}`);
      await ready(target);
    }
    const initialRequests = (await model()).requests.length;
    const initialSessions = (await sessions()).items.length;
    const command = async (text) => {
      await ready();
      await input().fill(text);
      const [reply] = await Promise.all([
        page.waitForResponse(
          (reply) =>
            new URL(reply.url()).pathname.endsWith("/commands") &&
            reply.request().method() === "POST" &&
            reply.request().postDataJSON()?.text === text,
        ),
        page.getByRole("button", { name: "Run command", exact: true }).click(),
      ]);
      assert.equal(reply.status(), 200, await reply.text());
      const body = await reply.json();
      commands.push(body.command);
      await ready();
      return body;
    };
    const configuration = async (id, expected, targets = [page, observer]) => {
      const selected = await until(
        async () => {
          const current = (await view(sessionId)).selectedView;
          return (
            current.configOptions.some(
              (item) => item.id === id && item.currentValue === expected,
            ) && current
          );
        },
        `${id} persisted by ACP`,
        signal,
        25_000,
      );
      const option = selected.configOptions.find((item) => item.id === id);
      const choices = option.options.flatMap((item) =>
        "options" in item ? item.options : [item],
      );
      const label = choices.find((item) => item.value === expected)?.name;
      assert.ok(label, `missing advertised ${id} value`);
      for (const target of targets) {
        const picker = target.getByRole("combobox", {
          name: option.name,
          exact: true,
        });
        await until(
          async () => (await picker.textContent())?.includes(label),
          `${id} rendered from current server state`,
          signal,
          25_000,
        );
      }
    };
    await command(`/model profile:${reasoning.model_profile_id}`);
    await configuration("model", `profile:${reasoning.model_profile_id}`);
    await command("/thinking high");
    await configuration("thinking_effort", "high");
    const previousMode = (
      await view(sessionId)
    ).selectedView.configOptions.find(
      (option) => option.id === "mode",
    ).currentValue;
    const mode = previousMode === "auto" ? "chat" : "auto";
    await command(`/mode ${mode}`);
    await configuration("mode", mode);
    await page.reload();
    await ready();
    await configuration("model", `profile:${reasoning.model_profile_id}`);
    await configuration("thinking_effort", "high");
    await page
      .locator(".message-assistant .message-content")
      .filter({ hasText: "c4-browser-hold-after-cancel completed" })
      .waitFor();
    await page.screenshot({
      path: `${output}/model-controls.png`,
      fullPage: true,
    });
    const thinkingName = (
      await view(sessionId)
    ).selectedView.configOptions.find(
      (option) => option.id === "thinking_effort",
    ).name;
    await command("/model agent_default");
    await configuration("model", "agent_default");
    for (const target of [page, observer])
      await until(
        async () =>
          (await target
            .getByRole("combobox", { name: thinkingName, exact: true })
            .count()) === 0,
        "model switch removes unsupported thinking control",
        signal,
        25_000,
      );
    assert.equal((await model()).requests.length, initialRequests);

    await command("/new");
    await until(
      () => workspaceLocation(page.url()).sessionId === null,
      "draft URL after /new",
      signal,
      25_000,
    );
    await until(
      async () =>
        (await page
          .locator('.conversation-option[aria-current="page"]')
          .count()) === 0,
      "draft clears sidebar selection",
      signal,
      25_000,
    );
    assert.equal((await sessions()).items.length, initialSessions);
    assert.equal(workspaceLocation(observer.url()).sessionId, sessionId);
    await page.screenshot({
      path: `${output}/new-conversation.png`,
      fullPage: true,
    });
    await command(`/resume ${sessionId}`);
    await until(
      () => workspaceLocation(page.url()).sessionId === sessionId,
      "selected URL after /resume",
      signal,
      25_000,
    );
    await page.locator('.conversation-option[aria-current="page"]').waitFor();
    await page
      .locator(".message-assistant .message-content")
      .filter({ hasText: "c4-browser-hold-after-cancel completed" })
      .waitFor();
    assert.equal((await sessions()).items.length, initialSessions);

    const fork = await command("/fork");
    assert.ok(
      fork.selection.sessionId && fork.selection.sessionId !== sessionId,
    );
    await until(
      () =>
        workspaceLocation(page.url()).sessionId === fork.selection.sessionId,
      "fork URL selection",
      signal,
      25_000,
    );
    await page.locator('.conversation-option[aria-current="page"]').waitFor();
    await until(
      async () =>
        (await page.locator(".conversation-option").count()) ===
        initialSessions + 1,
      "fork appears in conversation history",
      signal,
      25_000,
    );
    await page.reload();
    await ready();
    assert.equal(
      workspaceLocation(page.url()).sessionId,
      fork.selection.sessionId,
    );
    await page
      .locator(".message-assistant .message-content")
      .filter({ hasText: "c4-browser-hold-after-cancel completed" })
      .waitFor();
    assert.equal(workspaceLocation(observer.url()).sessionId, sessionId);
    assert.equal((await sessions()).items.length, initialSessions + 1);
    assert.equal(
      (await model()).requests.length,
      initialRequests,
      "controls must not invoke the Provider",
    );
    assert.deepEqual(errors, []);
    return {
      status: "passed",
      commands,
      forkSessionId: fork.selection.sessionId,
      modelRequests: initialRequests,
      observerSessionId: sessionId,
    };
  } catch (error) {
    await page
      ?.screenshot({ path: `${output}/failure.png`, fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
  }
}
