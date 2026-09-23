import assert from "node:assert/strict";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { member, until } from "./c4-setup.mjs";
import { note, imageData } from "./browser-model.mjs";
import { audioData } from "../acp-multimodal/fixtures.mjs";
import {
  assertReadableText,
  assertTouchTargets,
} from "../../integration/agent-ui/visual-assertions.mjs";

export async function runBrowser(
  config,
  fixture,
  signal,
  output,
  report,
  checkpoint,
) {
  // The coordinator owns signals and Docker cleanup. Playwright's default
  // SIGINT handler exits the Node process before the runner's finally block.
  const browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const abort = () => void browser.close();
  signal.addEventListener("abort", abort, { once: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const frames = [];
  const errors = [];
  const paths = [];
  const pageTasks = [];
  const pageFrames = new WeakMap();
  const track = (page) => {
    const received = [];
    pageFrames.set(page, received);
    page.setDefaultTimeout(25000);
    page.on("pageerror", () => errors.push("page error"));
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        frames.push(String(payload));
        try {
          received.push(JSON.parse(String(payload)));
        } catch {
          errors.push("invalid ACP JSON frame");
        }
      }),
    );
    page.on("response", (response) => {
      const url = new URL(response.url());
      // SSE watches have no finite response body. Their state payloads are
      // schema-checked by the production client; audit finite JSON and ACP here.
      if (
        url.pathname.startsWith("/api/app/") &&
        !url.pathname.endsWith("/watch")
      ) {
        paths.push(url.pathname);
        pageTasks.push(
          response.text().then(
            (body) => frames.push(body),
            () => {},
          ),
        );
      }
    });
    return page;
  };
  let page = track(await context.newPage());
  const url = `${config.gateway}/workspace/?agent=${fixture.agentID}`;
  const input = (target = page) =>
    target.getByRole("textbox", { name: "Message", exact: true });
  const enabled = (target = page) =>
    until(() => input(target).isEnabled(), "composer ready", signal);
  const state = async () => {
    const response = await context.request.get(
      `${config.gateway}/api/app/agents/${fixture.agentID}/state`,
    );
    assert.equal(response.status(), 200);
    const body = await response.json();
    frames.push(JSON.stringify(body));
    return body;
  };
  const model = async (path = "/status", method = "GET") => {
    const response = await fetch(config.model + path, {
      method,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  async function prompt(phase, response, target = page) {
    await enabled(target);
    await input(target).fill(phase);
    await target
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    if (response) {
      await target
        .locator(".message-assistant .message-content")
        .filter({ hasText: response })
        .waitFor();
      await enabled(target);
    }
    await until(
      () => new URL(target.url()).searchParams.get("session"),
      "session URL",
      signal,
    );
    report.sessions[phase] = new URL(target.url()).searchParams.get("session");
  }
  async function held(phase, target = page) {
    await prompt(phase, undefined, target);
    await until(
      async () => (await model()).pending.includes(phase),
      "held model request",
      signal,
    );
  }
  async function check(name) {
    report.checks.push(name);
    console.error(`C4 passed: ${name}`);
    await checkpoint();
  }
  const sessionInfo = (target, sessionId) =>
    pageFrames
      .get(target)
      .findLast(
        (frame) =>
          frame.method === "session/update" &&
          frame.params?.sessionId === sessionId &&
          frame.params.update.sessionUpdate === "session_info_update",
      )?.params.update;
  async function visibleInfo(target, expected) {
    const row = target.locator(".conversation-option.active");
    await until(
      async () =>
        (await row.locator("strong").textContent()) === expected.title &&
        (await row.locator("time").getAttribute("datetime")) ===
          expected.updatedAt,
      "visible authoritative session metadata",
      signal,
      10000,
    );
  }
  try {
    await page.goto(`${config.gateway}/workspace/`);
    for (const [name, value] of Object.entries(member))
      await page.locator(`[name="${name}"]`).fill(value);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/workspace/**");
    await page
      .getByRole("searchbox", { name: "Find an agent" })
      .fill("C4 Browser Agent");
    await page
      .locator(".chooser-agent")
      .filter({ hasText: "C4 Browser Agent" })
      .click();
    await enabled();
    assert(
      (await page.locator("body").innerText()).includes("C4 Browser Agent"),
    );
    await prompt("c4-browser-write", "Workspace note saved.");
    await page
      .getByRole("button", { name: "Show process", exact: true })
      .first()
      .click();
    assert((await page.locator(".tool-activity").count()) > 0);
    await page.locator(".tool-activity summary").first().click();
    await page
      .getByText("workspace-written", { exact: false })
      .first()
      .waitFor();
    const firstURL = page.url();
    await page.reload();
    await enabled();
    const observer = track(await context.newPage());
    await observer.goto(firstURL);
    await enabled(observer);
    const firstSession = new URL(firstURL).searchParams.get("session");
    const previousMetadata = sessionInfo(observer, firstSession);
    assert(previousMetadata, "observer must receive current Session metadata");
    await prompt("c4-browser-read", "Workspace note: alpha-beta.");
    await check("member_login_new_load_session_real_tools");
    await until(
      () =>
        sessionInfo(page, firstSession)?.updatedAt &&
        sessionInfo(page, firstSession).updatedAt !==
          previousMetadata.updatedAt &&
        sessionInfo(page, firstSession)?.updatedAt ===
          sessionInfo(observer, firstSession)?.updatedAt,
      "cross-page session metadata",
      signal,
    );
    const metadata = sessionInfo(page, firstSession);
    assert.equal(metadata.title, "c4-browser-write");
    await visibleInfo(page, metadata);
    await visibleInfo(observer, metadata);
    pageFrames.get(observer).length = 0;
    await observer.reload();
    await enabled(observer);
    const listed = pageFrames
      .get(observer)
      .flatMap((frame) => frame.result?.sessions ?? [])
      .find((session) => session.sessionId === firstSession);
    assert(listed, "fresh page must list the existing Session");
    assert.equal(listed.title, metadata.title);
    assert.equal(listed.updatedAt, metadata.updatedAt);
    assert.deepEqual(sessionInfo(observer, firstSession), metadata);
    await visibleInfo(observer, metadata);
    report.session_metadata = {
      title: metadata.title,
      before: previousMetadata.updatedAt,
      after: metadata.updatedAt,
      observers: 2,
      list_and_reload: "matched without changing activity time",
    };
    await observer.close();
    await check("cross_page_metadata_matches_list_and_reload");

    await page.getByLabel("File attachments", { exact: true }).setInputFiles([
      {
        name: "workspace-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(note),
      },
      {
        name: "sample.png",
        mimeType: "image/png",
        buffer: Buffer.from(imageData, "base64"),
      },
    ]);
    assert.equal(await page.locator(".composer-attachment").count(), 2);
    assert.equal(await page.locator(".composer-attachment img").count(), 1);
    await prompt(
      "c4-browser-attachments",
      "Attachment bytes and image verified.",
    );
    assert.equal(await page.locator(".message-attachment").count(), 2);
    await page.getByLabel("File attachments", { exact: true }).setInputFiles({
      name: "unsupported.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0, 255]),
    });
    await page
      .getByRole("alert")
      .filter({ hasText: "not supported" })
      .waitFor();
    assert.equal(await page.locator(".composer-attachment").count(), 0);
    await page.screenshot({
      path: `${output}/desktop-attachments.png`,
      fullPage: true,
    });
    await page.reload();
    await enabled();
    const negative = track(await context.newPage());
    await negative.goto(url);
    await enabled(negative);
    const beforeRejected = (await model()).requests.length;
    await negative
      .getByLabel("File attachments", { exact: true })
      .setInputFiles({
        name: "unsupported.wav",
        mimeType: "audio/wav",
        buffer: Buffer.from(audioData, "base64"),
      });
    await prompt("c4-browser-unsupported-audio", undefined, negative);
    await negative
      .getByRole("alert")
      .filter({
        hasText: /does not accept audio|unsupported.*content|not support/i,
      })
      .waitFor();
    await enabled(negative);
    assert.equal((await model()).requests.length, beforeRejected);
    await negative.screenshot({
      path: `${output}/desktop-capability-rejection.png`,
      fullPage: true,
    });
    await negative.close();
    await check("attachment_bytes_previews_format_and_capability_rejections");

    await page.getByRole("combobox", { name: "Mode", exact: true }).click();
    await page.getByRole("option", { name: /^Approve\b/ }).click();
    await prompt("c4-browser-approve");
    await page.getByRole("region", { name: "Tool approval" }).waitFor();
    await page.getByText("Permission required", { exact: true }).waitFor();
    await page.screenshot({
      path: `${output}/desktop-permission.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await page
      .getByText("c4-browser-approve: retained note alpha-beta verified.", {
        exact: true,
      })
      .waitFor();
    await enabled();
    await page.getByRole("combobox", { name: "Mode", exact: true }).click();
    await page.getByRole("option", { name: /^Auto\b/ }).click();
    await check("real_tool_permission_interaction");

    const other = track(await context.newPage());
    await other.goto(url);
    await enabled(other);
    await held("c4-browser-hold-cancel");
    await until(
      async () => !(await input(other).isEnabled()),
      "cross-session busy",
      signal,
    );
    await other
      .getByRole("button", { name: "Stop operation", exact: true })
      .click();
    await until(
      async () =>
        (await model()).requests.some(
          (r) => r.phase === "c4-browser-hold-cancel" && r.disconnected,
        ),
      "model canceled",
      signal,
    );
    await enabled(other);
    await prompt(
      "c4-browser-after-cancel",
      "c4-browser-after-cancel completed",
      other,
    );
    assert.notEqual(
      new URL(other.url()).searchParams.get("session"),
      new URL(firstURL).searchParams.get("session"),
    );
    await other.close();
    await enabled();
    await check("two_sessions_busy_cancel_and_readmission");

    await held("c4-browser-hold-offline");
    const offlineURL = page.url();
    await context.setOffline(true);
    // A navigation also closes an existing WebSocket on browsers that retain it
    // when network emulation changes. No ACP or Gateway request is mocked.
    await page.goto(offlineURL).catch(() => {});
    await model("/release/c4-browser-hold-offline", "POST");
    await until(
      async () => !(await fixture.state()).active_session_id,
      "offline completion",
      signal,
    );
    await context.setOffline(false);
    await page.goto(offlineURL);
    await page
      .getByText("c4-browser-hold-offline completed", { exact: true })
      .waitFor();
    await enabled();
    assert.equal(
      (await model()).requests.filter(
        (r) => r.phase === "c4-browser-hold-offline",
      ).length,
      1,
    );
    await check("offline_completion_history_without_resubmission");

    await held("c4-browser-hold-close");
    const closedURL = page.url();
    await page.close();
    await model("/release/c4-browser-hold-close", "POST");
    page = track(await context.newPage());
    await page.goto(closedURL);
    await page
      .getByText("c4-browser-hold-close completed", { exact: true })
      .waitFor();
    await enabled();
    assert.equal(
      (await model()).requests.filter(
        (r) => r.phase === "c4-browser-hold-close",
      ).length,
      1,
    );
    await check("close_reopen_history_without_resubmission");

    const before = await state();
    const rebuilt = await fixture.json(
      `/api/admin/agents/${fixture.agentID}/rebuild`,
      {
        status: 202,
        body: {
          template_id: fixture.template.template_id,
          template_revision: fixture.template.revision,
        },
      },
    );
    await until(
      async () => !(await input().isEnabled()),
      "open page observes rebuild",
      signal,
    );
    await page.screenshot({
      path: `${output}/desktop-rebuild.png`,
      fullPage: true,
    });
    await fixture.operation((rebuilt.operation ?? rebuilt).request_id);
    await fixture.ready();
    await until(
      async () =>
        (await state()).configuration_revision !==
        before.configuration_revision,
      "rebuilt configuration",
      signal,
    );
    await enabled();
    await prompt(
      "c4-browser-after-rebuild",
      "c4-browser-after-rebuild: retained note alpha-beta verified.",
    );
    await fixture.verifyWorkspace();
    await check("open_page_rebuild_retains_workspace_and_history");

    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await prompt("c4-browser-mobile", "Mobile conversation ready.");
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await assertReadableText(page, [".message-content", ".composer-hint"]);
    assert.equal(await page.locator(".send-button").count(), 1);
    await assertTouchTargets(
      page,
      '.send-button, button[aria-label="Open navigation"]',
    );
    await page.screenshot({
      path: `${output}/mobile-conversation.png`,
      fullPage: true,
    });
    await check("mobile_layout_input_completion");

    await fixture.json(`/api/admin/directory/users/${fixture.ownerID}/active`, {
      body: { active: false },
    });
    await until(
      async () => (await input().count()) === 0 || !(await input().isEnabled()),
      "open page loses access",
      signal,
    );
    // A temporary unknown state is not final identity-revocation feedback.
    // The failed authenticated bootstrap must return the open page to login.
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(await input().count(), 0);
    assert.equal(await page.locator(".message-content").count(), 0);
    await until(
      async () =>
        (await fixture.json(`/api/admin/agents/${fixture.agentID}`))
          .activation_state === "disabled",
      "revocation propagated",
      signal,
    );
    await page.screenshot({
      path: `${output}/mobile-revoked.png`,
      fullPage: true,
    });
    await check("open_page_identity_revocation");
    // Closing pages also settles response reads aborted by a navigation.
    await context.close();
    await Promise.all(pageTasks);
    assert.deepEqual(errors, []);
    assert(paths.length > 0 && frames.length > 0);
    for (const body of frames)
      for (const value of [
        "stage3-model-secret",
        "mcp_endpoint",
        "access_subject",
        "http://stage3-model",
        "http://runtime-",
      ])
        assert(!body.includes(value), `private browser data: ${value}`);
    const status = await model();
    assert.deepEqual(status.errors, []);
    assert.deepEqual(status.pending, []);
    report.model = status;
    report.browser_errors = errors.length;
    report.browser_payloads_checked = frames.length;
    await check("private_runtime_and_provider_data_absent");
  } catch (error) {
    report.model = await model().catch(() => null);
    if (!page.isClosed()) {
      report.failure_page = await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable");
      await page
        .screenshot({ path: `${output}/failure.png`, fullPage: true })
        .catch(() => {});
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
  }
}
