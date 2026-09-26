import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import {
  assertReadableText,
  assertTouchTargets,
} from "../../integration/agent-ui/visual-assertions.mjs";
import { until } from "./c4-setup.mjs";
import { note, imageData } from "./browser-model.mjs";
import { browserRecorder } from "./browser-current.mjs";

export async function runMigratedBrowser({
  config,
  agentID,
  signal,
  model,
  audits,
  verifyWorkspace,
}) {
  const output = `${config.evidence}/screenshots`;
  await mkdir(output, { mode: 0o700 });
  const browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const abort = () => void browser.close();
  signal.addEventListener("abort", abort, { once: true });
  let page;
  const errors = [],
    reads = [];
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(25000);
    const recorder = browserRecorder(agentID),
      bodies = [],
      checks = [];
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    for (const [event, method] of [
      ["webSocketCreated", "created"],
      ["webSocketHandshakeResponseReceived", "handshake"],
      ["webSocketFrameSent", "sent"],
      ["webSocketFrameReceived", "received"],
    ])
      cdp.on(`Network.${event}`, (value) => {
        try {
          recorder[method](value);
        } catch (error) {
          errors.push(error.message);
        }
      });
    page.on("pageerror", () => errors.push("page error"));
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => bodies.push(String(payload))),
    );
    page.on("response", (response) => {
      const p = new URL(response.url()).pathname;
      if (p.startsWith("/api/app/") && !p.endsWith("/watch"))
        reads.push(
          response.text().then(
            (body) => bodies.push(body),
            () => {},
          ),
        );
    });
    const input = () =>
      page.getByRole("combobox", { name: "Message", exact: true });
    const enabled = () =>
      until(() => input().isEnabled(), "browser composer ready", signal);
    const reply = (text) =>
      page
        .locator(".message-assistant .message-content")
        .filter({ hasText: text });
    const check = async (name) => {
      assert.deepEqual(errors, []);
      checks.push(name);
      await writeFile(
        `${config.evidence}/browser-checks.private.json`,
        JSON.stringify(checks),
        { mode: 0o600 },
      );
      console.error(`Browser passed: ${name}`);
    };
    const prompt = async (phase, text) => {
      await enabled();
      await input().fill(phase);
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await reply(text).waitFor();
      await enabled();
    };
    const countHistory = async () => {
      for (const text of [
        "Workspace note saved.",
        "Workspace note: alpha-beta.",
        "Attachment bytes and image verified.",
      ])
        assert.equal(
          await reply(text).count(),
          1,
          "replay duplicated or lost answer",
        );
      assert.equal(await page.locator(".message-attachment").count(), 2);
      assert.equal(await page.locator(".message-attachment img").count(), 1);
    };
    await page.goto(`${config.gateway}/workspace/`);
    for (const [name, value] of Object.entries({
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    }))
      await page.locator(`[name="${name}"]`).fill(value);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/workspace/**");
    await page
      .getByRole("searchbox", { name: "Find a workspace" })
      .fill("Browser Agent");
    await page
      .locator(".chooser-agent")
      .filter({ hasText: "Browser Agent" })
      .click();
    await prompt("c4-browser-write", "Workspace note saved.");
    const process = page.getByRole("button", {
      name: "Show process",
      exact: true,
    });
    assert.equal(await process.count(), 1);
    assert.equal(await page.locator(".tool-activity:visible").count(), 0);
    await process.click();
    await page.locator(".tool-activity summary").first().click();
    await page
      .getByText("workspace-written", { exact: false })
      .first()
      .waitFor();
    await page.screenshot({
      path: `${output}/desktop-tools.png`,
      fullPage: true,
    });
    await prompt("c4-browser-read", "Workspace note: alpha-beta.");
    await verifyWorkspace();
    await check("real_tools_and_collapsed_activity");
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
    await countHistory();
    const beforeRejected = await model();
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
    assert.deepEqual(await model(), beforeRejected);
    await reply(
      "Attachment bytes and image verified.",
    ).scrollIntoViewIfNeeded();
    for (const attachment of await page.locator(".message-attachment").all()) {
      const bounds = await attachment.boundingBox();
      assert(
        bounds &&
          bounds.y >= 70 &&
          bounds.y + bounds.height < page.viewportSize().height,
        "attachment preview outside screenshot viewport",
      );
    }
    await page.screenshot({
      path: `${output}/desktop-attachments.png`,
      fullPage: true,
    });
    await check("attachment_bytes_previews_and_unsupported_file");
    const beforeReplay = await audits(),
      ledger = await model(),
      beforeRequests = recorder.requests.length;
    await page.reload();
    await enabled();
    await countHistory();
    assert(
      recorder.requests
        .slice(beforeRequests)
        .some((r) => r.method === "session/load"),
      "reload did not load the existing Session",
    );
    assert.deepEqual(await audits(), beforeReplay, "replay rewrote Run/events");
    assert.deepEqual(await model(), ledger, "replay invoked model or Tools");
    await verifyWorkspace();
    await page.screenshot({
      path: `${output}/desktop-replay.png`,
      fullPage: true,
    });
    await check("reload_exact_history_without_execution");
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
    await assertTouchTargets(
      page,
      '.send-button, button[aria-label="Open navigation"]',
    );
    await page.screenshot({
      path: `${output}/mobile-conversation.png`,
      fullPage: true,
    });
    await check("mobile_distinct_session_layout_and_controls");
    await context.close();
    await Promise.all(reads);
    assert.deepEqual(errors, []);
    assert(bodies.length > 0);
    for (const body of bodies)
      for (const secret of [
        "stage3-model-secret",
        "mcp_endpoint",
        "access_subject",
        "http://stage3-model",
        "http://runtime-",
      ])
        assert(
          !body.includes(secret),
          "private execution data in browser response",
        );
    await check("browser_response_privacy");
    return {
      checks,
      requests: recorder.requests,
      browser_payloads_checked: bodies.length,
      screenshots: 4,
    };
  } catch (error) {
    await writeFile(
      `${config.evidence}/browser-errors.private.json`,
      JSON.stringify(errors),
      { mode: 0o600 },
    );
    if (page && !page.isClosed())
      await page
        .screenshot({ path: `${output}/failure.png`, fullPage: true })
        .catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
    await Promise.all(reads);
  }
}
