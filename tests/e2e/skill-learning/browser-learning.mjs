import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { gatewayBrowserRequest } from "../../support/gateway-browser-request.mjs";
import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";

// Opt-in real-stack functional admission; visual polish follows human acceptance.
export async function openLearningBrowser({
  config,
  fixture,
  signal,
  output,
  sessionId,
}) {
  signal.throwIfAborted();
  await mkdir(output, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  let closing;
  const close = () => (closing ??= browser.close());
  const abort = () => void close().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  const errors = [];
  const diagnosticRequests = [];
  let page;
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
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
      target.on("request", (request) => {
        const url = new URL(request.url());
        if (url.searchParams.get("learningStatus") === "1")
          diagnosticRequests.push(url.pathname);
      });
      return target;
    };
    page = track(await context.newPage());
    const draft = `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/`;
    const input = (target = page) =>
      target.getByRole("combobox", { name: "Message", exact: true });
    const ready = (target = page) =>
      until(
        () => input(target).isEnabled(),
        "learning composer ready",
        signal,
        30_000,
      );
    await page.goto(
      sessionId ? `${draft}sessions/${encodeURIComponent(sessionId)}` : draft,
    );
    await ready();
    assert.deepEqual(
      diagnosticRequests,
      [],
      "diagnostic is not queried before results open",
    );
    const view = async () => {
      const selected = workspaceLocation(page.url()).sessionId;
      const url = `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}/view${selected ? `?sessionId=${encodeURIComponent(selected)}` : ""}`;
      const response = await gatewayBrowserRequest(context, url);
      assert.equal(response.status(), 200);
      return response.json();
    };
    const prompt = async (text, reply) => {
      await ready();
      const replies = page
        .locator(".message-assistant .message-content")
        .filter({ hasText: reply });
      const previous = await replies.count();
      await input().fill(text);
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await until(
        async () => (await replies.count()) > previous,
        "new foreground reply rendered",
        signal,
        90_000,
      );
    };
    const toast = async (kind) => {
      const item = page.locator(".learning-notices-toast");
      await item.waitFor({ timeout: 60_000 });
      assert.equal(await item.count(), 1);
      assert.equal(
        (await item.locator("strong").textContent())?.trim(),
        kind === "skill_created" ? "New skill learned" : "Skill updated",
      );
    };
    const notice = (kind) =>
      until(
        async () =>
          (await view()).systemNotices?.find((item) => item.kind === kind),
        `browser ${kind} matches its authoritative record`,
        signal,
        30_000,
      );
    const results = (target = page) =>
      target.getByRole("button", { name: /^Skill learning results \(/u });
    const openResults = async (target = page) => {
      if (await target.locator(".learning-notices-panel").count())
        await results(target).click();
      const [response] = await Promise.all([
        target.waitForResponse(
          (reply) =>
            new URL(reply.url()).searchParams.get("learningStatus") === "1",
        ),
        results(target).click(),
      ]);
      assert.equal(response.status(), 200);
      await target.locator(".learning-notices-panel").waitFor();
      return (await response.json()).learningStatus;
    };
    const sourceJump = async (selected) => {
      await page
        .getByRole("button", { name: "New conversation", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await until(
        () => workspaceLocation(page.url()).sessionId === null,
        "local draft before source jump",
        signal,
        25_000,
      );
      await openResults();
      const link = page
        .locator(".learning-notices-panel")
        .getByRole("link", { name: "View source conversation" })
        .first();
      const href = await link.getAttribute("href");
      assert(href);
      assert.equal(
        workspaceLocation(new URL(href, config.gateway).href).agentId,
        fixture.agentID,
      );
      assert.equal(
        workspaceLocation(new URL(href, config.gateway).href).sessionId,
        selected,
      );
      await link.click();
      await until(
        () => workspaceLocation(page.url()).sessionId === selected,
        "source conversation selected",
        signal,
        25_000,
      );
      await ready();
      await page
        .locator(".message-assistant .message-content")
        .filter({ hasText: "Fixture procedure completed." })
        .first()
        .waitFor();
    };
    const finish = async (count, deferred) => {
      await page.reload();
      await ready();
      await page
        .getByRole("button", {
          name: `Skill learning results (${count})`,
          exact: true,
        })
        .waitFor();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await page.locator(".learning-notices-toast").count(),
        0,
        "reload does not replay old result toasts",
      );
      const status = await openResults();
      assert.equal(status.agentId, fixture.agentID);
      assert.equal(
        status.blocked?.reason ?? null,
        deferred ? "runtime_unavailable" : null,
      );
      assert.equal(
        await page.locator(".learning-notices-panel li").count(),
        count,
      );
      if (deferred)
        await page
          .locator(".learning-notices-diagnostic")
          .filter({ hasText: "An earlier review could not finish." })
          .waitFor();
      await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
      const mobileContext = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const mobile = track(await mobileContext.newPage());
      await mobile.goto(page.url());
      await ready(mobile);
      await openResults(mobile);
      const panel = mobile.locator(".learning-notices-panel");
      assert.equal(await panel.locator("li").count(), count);
      const box = await panel.boundingBox();
      assert(
        box && box.x >= 0 && box.x + box.width <= 390,
        "mobile learning results fit the viewport",
      );
      assert.equal(await mobile.locator(".learning-notices-toast").count(), 0);
      if (deferred)
        await mobile
          .locator(".learning-notices-diagnostic")
          .filter({ hasText: "An earlier review could not finish." })
          .waitFor();
      await mobile.screenshot({ path: `${output}/mobile.png`, fullPage: true });
      assert.deepEqual(errors, []);
      return {
        status: "passed",
        resultCount: count,
        sourceNavigation: true,
        reloadToasts: 0,
        diagnosticRequests: diagnosticRequests.length,
      };
    };
    const checked =
      (work) =>
      async (...args) => {
        try {
          return await work(...args);
        } catch (error) {
          await page
            .screenshot({ path: `${output}/failure.png`, fullPage: true })
            .catch(() => {});
          throw error;
        }
      };
    return {
      create: checked(async () => {
        await prompt(
          "learn: For the fixture task, inspect the target before editing it.",
          "Fixture procedure completed.",
        );
        await toast("skill_created");
        assert.deepEqual(
          diagnosticRequests,
          [],
          "success notice does not fetch diagnostics",
        );
        const created = await notice("skill_created");
        const selected = workspaceLocation(page.url()).sessionId;
        assert(selected);
        assert.equal(created.sourceSessionId, selected);
        assert.equal(created.agentId, fixture.agentID);
        await sourceJump(selected);
        return {
          status: "skill_created",
          agent_id: fixture.agentID,
          session_id: selected,
          created_change_id: created.changeId,
        };
      }),
      update: checked(async (created) => {
        assert.equal(
          workspaceLocation(page.url()).sessionId,
          created.session_id,
        );
        await prompt(
          "learn: For the fixture task, check the result after editing it.",
          "Fixture procedure completed.",
        );
        await toast("skill_updated");
        const updated = await notice("skill_updated");
        assert.equal(updated.sourceSessionId, created.session_id);
        assert.notEqual(updated.changeId, created.created_change_id);
        await prompt(
          "verify learned procedure",
          "Both learned rules are active.",
        );
        const response = await fetch(`${config.model}/status`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        });
        assert.equal(response.status, 200);
        const model = await response.json();
        assert.deepEqual(model.errors, []);
        for (const kind of [
          "review-create",
          "review-update",
          "foreground-verify-tool",
          "foreground-verify-reply",
        ])
          assert(model.requests.includes(kind), `missing model phase: ${kind}`);
        const proof = await finish(2, false);
        return {
          status: "automatic_learning_passed",
          agent_id: fixture.agentID,
          session_id: created.session_id,
          created_change_id: created.created_change_id,
          updated_change_id: updated.changeId,
          model_requests: model.requests,
          browser: proof,
        };
      }),
      inspectDeferredReview: checked(async (failedSourceRunId) => {
        const status = await openResults();
        assert.equal(status.agentId, fixture.agentID);
        assert.equal(status.blocked.reason, "runtime_unavailable");
        assert.equal(status.blocked.sourceRunId, failedSourceRunId);
        await page
          .locator(".learning-notices-diagnostic")
          .filter({ hasText: "An earlier review could not finish." })
          .waitFor();
        assert.equal(await page.locator(".learning-notices-toast").count(), 0);
        assert.equal(
          await input().isEnabled(),
          true,
          "deferred learning leaves the composer usable",
        );
        await results().click();
      }),
      verifyRecovered: checked(async (recovered) => {
        await toast("skill_created");
        const created = await notice("skill_created");
        assert.equal(created.changeId, recovered.change_id);
        assert.equal(created.sourceRunId, recovered.source_run_id);
        await sourceJump(recovered.session_id);
        return finish(1, true);
      }),
      close: async () => {
        signal.removeEventListener("abort", abort);
        await close();
      },
    };
  } catch (error) {
    await page
      ?.screenshot({ path: `${output}/failure.png`, fullPage: true })
      .catch(() => {});
    signal.removeEventListener("abort", abort);
    await close();
    throw error;
  }
}
