import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import { gatewayBrowserRequest } from "../../support/gateway-browser-request.mjs";
import assert from "node:assert/strict";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { member, until } from "./c4-setup.mjs";
import { note, imageData } from "./browser-model.mjs";
import { audioData } from "../acp-multimodal/fixtures.mjs";
import { observedHeldRun } from "./browser-control.mjs";
import { readC4View } from "./c4-view.mjs";
import { c4RebuildReady } from "./c4-rebuild.mjs";
import { runC4BrowserScope } from "./c4-browser-scope.mjs";
import { captureC4Login } from "./c4-login.mjs";
import { observeC4PageStreams } from "./c4-stream-observer.mjs";
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
  {
    launch = () =>
      chromium.launch({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      }),
  } = {},
) {
  // The coordinator owns signals and Docker cleanup. Playwright's default
  // SIGINT handler exits the Node process before the runner's finally block.
  return runC4BrowserScope({ signal, launch }, (scope) =>
    runBrowserInContext(
      config,
      fixture,
      signal,
      output,
      report,
      checkpoint,
      scope,
    ),
  );
}

async function runBrowserInContext(
  config,
  fixture,
  signal,
  output,
  report,
  checkpoint,
  scope,
) {
  const { context } = scope;
  const frames = [];
  const errors = [];
  let browserPhase = "startup";
  const paths = [];
  const streams = new Map();
  const track = (page) => {
    const observer = observeC4PageStreams(page, {
      gateway: config.gateway,
      agentId: fixture.agentID,
      signal,
    });
    streams.set(page, observer);
    scope.addObserver({
      async closeAndWait() {
        try {
          await observer.closeAndWait();
        } finally {
          report.page_streams = [...streams.values()].flatMap(
            (value) => value.records,
          );
        }
      },
    });
    page.setDefaultTimeout(25000);
    page.on("pageerror", (error) => {
      scope.recordFailure(error);
      errors.push({
        phase: browserPhase,
        url: page.url(),
        message: error.message,
      });
    });
    page.on("websocket", () => {
      const error = new Error("unexpected browser WebSocket");
      scope.recordFailure(error);
      errors.push(error.message);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      // SSE watches have no finite response body. Their state payloads are
      // schema-checked by the production client; audit finite JSON here.
      if (
        url.pathname.startsWith("/api/app/") &&
        !url.pathname.endsWith("/watch") &&
        !url.pathname.endsWith("/events") &&
        !response.headers()["content-type"]?.startsWith("text/event-stream")
      ) {
        paths.push(url.pathname);
        scope.track(async () => frames.push(await response.text()));
      }
    });
    return page;
  };
  let page = track(await context.newPage());
  const url = `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/`;
  const input = (target = page) =>
    target.getByRole("combobox", { name: "Message", exact: true });
  const enabled = (target = page) =>
    until(() => input(target).isEnabled(), "composer ready", signal);
  const newConversation = async (target) => {
    await target
      .getByRole("button", { name: "New conversation", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await enabled(target);
  };
  const view = (sessionId = null) =>
    readC4View(context, {
      gateway: config.gateway,
      agentId: fixture.agentID,
      sessionId,
      frames,
    });
  const model = async (path = "/status", method = "GET") => {
    const response = await fetch(config.model + path, {
      method,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (path === "/status") report.model = body;
    return body;
  };
  const openAgentPage = async (target) => {
    const bootstrap = scope.track(
      target.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/app/workspace/v1/bootstrap" && response.status() === 200,
      ),
    );
    await target.goto(url);
    await bootstrap;
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
      () => workspaceLocation(target.url()).sessionId,
      "session URL",
      signal,
    );
    report.sessions[phase] = workspaceLocation(target.url()).sessionId;
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
    browserPhase = name;
    report.checks.push(name);
    console.error(`C4 passed: ${name}`);
    await checkpoint();
  }
  const sessionInfo = async (sessionId) => {
    const body = await view(sessionId);
    return {
      title: body.selectedView.title,
      updatedAt: body.selectedView.updatedAt,
    };
  };
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
    const loginResponse = scope.track(
      page.waitForResponse(
        (response) =>
          response.url() ===
            new URL("/api/session/login", config.gateway).href &&
          response.request().method() === "POST",
      ),
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const originalLogin = await captureC4Login(page, await loginResponse, {
      gateway: config.gateway,
      ownerId: fixture.ownerID,
    });
    report.page_login = {
      issued: originalLogin.issued,
      receipt: originalLogin.receipt,
    };
    await page.waitForURL("**/workspace/**");
    await page
      .getByRole("searchbox", { name: "Find a workspace" })
      .fill("C4 Browser Agent");
    await page
      .locator(".chooser-agent")
      .filter({ hasText: "C4 Browser Agent" })
      .click();
    await enabled(page);
    assert.equal(
      workspaceLocation(page.url()).sessionId,
      null,
      "opening an Agent must remain a local draft",
    );
    const workspaceSwitcher = page.getByRole("button", {
      name: "Switch workspace: C4 Browser Agent",
    });
    const conversations = page.getByRole("region", {
      name: "Conversations in C4 Browser Agent",
    });
    const contextBounds = await workspaceSwitcher.boundingBox();
    const actionBounds = await conversations
      .getByRole("button", { name: "New conversation" })
      .boundingBox();
    assert.ok(
      contextBounds.y + contextBounds.height <= actionBounds.y,
      "Workspace selection scopes the conversation actions below it",
    );
    await workspaceSwitcher.click();
    await page.getByRole("group", { name: "Workspaces" }).waitFor();
    await page.screenshot({
      path: `${output}/desktop-workspace-switcher.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    assert.equal(
      await workspaceSwitcher.getAttribute("aria-expanded"),
      "false",
    );
    await check("workspace context above conversation navigation");
    const draftLayout = await page
      .locator(".thread-draft")
      .evaluate((region) => {
        const heading = region.querySelector(".empty-thread");
        const composer = region.querySelector(".composer");
        if (!heading || !composer) return null;
        const outer = region.getBoundingClientRect();
        const first = heading.getBoundingClientRect();
        const last = composer.getBoundingClientRect();
        return {
          offset: Math.abs(
            (first.top + last.bottom) / 2 - (outer.top + outer.bottom) / 2,
          ),
          allowance: outer.height * 0.12,
        };
      });
    assert(
      draftLayout && draftLayout.offset <= draftLayout.allowance,
      `new conversation greeting and composer should be centered: ${JSON.stringify(draftLayout)}`,
    );
    await page.screenshot({
      path: `${output}/desktop-new-conversation.png`,
      fullPage: true,
    });
    assert(
      (await page.locator("body").innerText()).includes("C4 Browser Agent"),
    );
    await prompt("c4-browser-write", "Workspace note saved.");
    assert(
      workspaceLocation(page.url()).sessionId,
      "first send must create and select a Session",
    );
    await page
      .getByRole("button", { name: "Show process", exact: true })
      .first()
      .click();
    // Showing the process fetches its items, so the activity renders later.
    await page.locator(".tool-activity").first().waitFor();
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
    const firstSession = workspaceLocation(firstURL).sessionId;
    const previousMetadata = await sessionInfo(firstSession);
    assert(previousMetadata, "observer must receive current Session metadata");
    await prompt("c4-browser-read", "Workspace note: alpha-beta.");
    await check("member_login_new_load_session_real_tools");
    await until(
      async () =>
        (await sessionInfo(firstSession)).updatedAt !==
        previousMetadata.updatedAt,
      "cross-page session metadata",
      signal,
    );
    const metadata = await sessionInfo(firstSession);
    assert.equal(metadata.title, "c4-browser-write");
    await visibleInfo(page, metadata);
    await visibleInfo(observer, metadata);
    await observer.reload();
    await enabled(observer);
    const listedResponse = await gatewayBrowserRequest(
      context,
      `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
    );
    assert.equal(listedResponse.status(), 200);
    const listedBody = await listedResponse.json();
    frames.push(JSON.stringify(listedBody));
    const listed = listedBody.items.find(
      (session) => session.sessionId === firstSession,
    );
    assert(listed, "fresh page must list the existing Session");
    assert.equal(listed.title, metadata.title);
    assert.equal(listed.updatedAt, metadata.updatedAt);
    assert.deepEqual(await sessionInfo(firstSession), metadata);
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
    await openAgentPage(negative);
    await newConversation(negative);
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
    await openAgentPage(other);
    await newConversation(other);
    await input(other).fill("Waiting in a separate draft");
    await held("c4-browser-hold-cancel");
    await until(
      async () =>
        !(await other
          .getByRole("button", { name: "Send message" })
          .isEnabled()),
      "cross-session busy",
      signal,
    );
    const heldSession = report.sessions["c4-browser-hold-cancel"];
    report.cancelled_run_view = await view(heldSession);
    report.cancelled_run = observedHeldRun(
      report.cancelled_run_view,
      fixture.agentID,
      heldSession,
    );
    await page
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
    await until(
      async () =>
        other.getByRole("button", { name: "Send message" }).isEnabled(),
      "cross-session send available",
      signal,
    );
    await prompt(
      "c4-browser-after-cancel",
      "c4-browser-after-cancel completed",
      other,
    );
    assert.notEqual(
      workspaceLocation(other.url()).sessionId,
      workspaceLocation(firstURL).sessionId,
    );
    await other.close();
    await enabled();
    await check("two_sessions_busy_cancel_and_readmission");

    await held("c4-browser-hold-offline");
    const offlineURL = page.url();
    await context.setOffline(true);
    // A navigation closes the page's existing Bridge event stream even when
    // network emulation leaves established connections open.
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

    const rebuildSession = workspaceLocation(page.url()).sessionId;
    assert(rebuildSession, "Rebuild must retain an existing Session");
    const before = await fixture.state();
    const beforeRebuildRequests = (await model()).requests.length;
    const rebuildDraft = "Draft retained while the Agent rebuilds";
    await input().fill(rebuildDraft);
    const sendDuringRebuild = page.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    assert(await sendDuringRebuild.isEnabled());
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
      () => sendDuringRebuild.isDisabled(),
      "open page blocks ordinary prompts during rebuild",
      signal,
    );
    assert(
      await input().isEnabled(),
      "rebuild removed the control-command input",
    );
    await input().press("Enter");
    assert.equal(await input().inputValue(), rebuildDraft);
    await page.screenshot({
      path: `${output}/desktop-rebuild.png`,
      fullPage: true,
    });
    await fixture.operation((rebuilt.operation ?? rebuilt).request_id);
    await fixture.ready();
    assert.equal(
      workspaceLocation(page.url()).sessionId,
      rebuildSession,
      "Rebuild lost the original browser Session",
    );
    await until(
      async () =>
        c4RebuildReady(
          before,
          await fixture.state(),
          await view(rebuildSession),
          fixture.agentID,
          rebuildSession,
        ),
      "rebuilt private configuration and ready browser view",
      signal,
    );
    await enabled();
    assert.equal(workspaceLocation(page.url()).sessionId, rebuildSession);
    assert.equal(
      (await model()).requests.length,
      beforeRebuildRequests,
      "blocked rebuild draft invoked the model",
    );
    await prompt(
      "c4-browser-after-rebuild",
      "c4-browser-after-rebuild: retained note alpha-beta verified.",
    );
    assert.equal(report.sessions["c4-browser-after-rebuild"], rebuildSession);
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

    const pageObserver = streams.get(page);
    const beforeRevocation = await pageObserver.checkpoint({
      sessionId: workspaceLocation(page.url()).sessionId,
      cookies: originalLogin.cookies,
    });
    const cause = {
      kind: "user_deactivated",
      method: "POST",
      path: `/api/admin/directory/users/${fixture.ownerID}/active`,
      requestBody: { active: false },
      actor: structuredClone(fixture.adminPrincipal),
      target: structuredClone(originalLogin.issued.principal),
      startedMono: performance.now(),
      startedAt: Date.now(),
    };
    report.browser_revocation = {
      principal: originalLogin.issued.principal,
      checkpoint: beforeRevocation,
      cause,
    };
    const revoked = await fixture.request(cause.path, {
      body: { active: false },
    });
    Object.assign(cause, {
      completedMono: performance.now(),
      completedAt: Date.now(),
      status: revoked.status,
      body: revoked.body,
      traceID: revoked.traceID,
      serverDate: revoked.headers.get("date"),
    });
    Object.assign(
      report.browser_revocation,
      await pageObserver.waitForRemoteEnd(beforeRevocation),
    );
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
    await scope.closeContext();
    await scope.joinTasks();
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
    scope.recordFailure(error);
    await scope.capture(() => model());
    if (!page.isClosed()) {
      await scope.capture(async () => {
        report.failure_page = await page.locator("body").innerText();
      });
      await scope.capture(() =>
        page.screenshot({ path: `${output}/failure.png`, fullPage: true }),
      );
    }
    throw error;
  }
}
