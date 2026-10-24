import assert from "node:assert/strict";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { captureNavigationResponse } from "../../support/browser-navigation-response.mjs";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";
import { sendBrowserPrompt } from "../agent-ui/browser-prompt-send.mjs";
import { runC4BrowserScope } from "../workspace-closeout/c4-browser-scope.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

export async function withSurvivorBrowser(
  config,
  { signal, member, ownerId },
  work,
) {
  const gateway = new URL(config.gateway).origin;
  assert.equal(typeof ownerId, "string");
  assert(ownerId.length > 0);
  for (const name of ["organization_slug", "email", "password"])
    assert(typeof member[name] === "string" && member[name].length > 0);
  const launch = () =>
    chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

  return runC4BrowserScope({ signal, launch }, async (scope) => {
    const receipts = [];
    const newPage = async () => {
      const page = await scope.track(() => scope.context.newPage());
      page.setDefaultTimeout(30_000);
      page.on("pageerror", (error) => scope.recordFailure(error));
      return page;
    };
    const composer = (page) =>
      page.getByRole("combobox", { name: "Message", exact: true });
    const poll = (check, label) => until(check, label, signal, 30_000);
    const closePage = (page) =>
      scope.track(async () => {
        await page.close();
      });

    await scope.track(async () => {
      const page = await newPage();
      await page.goto(new URL("/workspace/", gateway).href, {
        waitUntil: "domcontentloaded",
      });
      for (const name of ["organization_slug", "email", "password"])
        await page.locator(`[name="${name}"]`).fill(member[name]);
      const { response, body } = await captureNavigationResponse(
        page,
        { url: new URL("/api/session/login", gateway).href },
        () =>
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
      );
      // The durable original body is consumed before this login page closes.
      assert.equal(response.status(), 200);
      const login = JSON.parse(body.toString("utf8"));
      assert.equal(login.principal.user_id, ownerId);
      assert.equal(login.principal.organization_slug, member.organization_slug);
      assert.equal(login.principal.organization_role, "member");
      assert.equal(login.principal.active, true);
      const issued = gatewaySessionCookies(
        (await response.headersArray())
          .filter((header) => header.name.toLowerCase() === "set-cookie")
          .map((header) => header.value),
      );
      const stored = gatewaySessionCookies(
        (await scope.context.storageState()).cookies,
      );
      assert(issued.accessToken && issued.csrf);
      assert.deepEqual(stored, issued);
      // Agent pages share the authenticated context. Closing this page also
      // avoids competing with its application-triggered post-login navigation.
      await closePage(page);
    });

    const openAgent = (agentId) =>
      scope.track(async () => {
        signal?.throwIfAborted();
        assert(typeof agentId === "string" && agentId.length > 0);
        const page = await newPage();
        await page.goto(
          new URL(`/workspace/${encodeURIComponent(agentId)}/`, gateway).href,
          {
            waitUntil: "domcontentloaded",
          },
        );
        let requestedConversation = false;
        await poll(async () => {
          const input = composer(page);
          if ((await input.isVisible()) && (await input.isEnabled()))
            return true;
          const create = page
            .getByRole("button", { name: "New conversation", exact: true })
            .filter({ visible: true })
            .first();
          if (
            !requestedConversation &&
            (await create.isVisible()) &&
            (await create.isEnabled())
          ) {
            requestedConversation = true;
            await create.click();
          }
          return (await input.isVisible()) && (await input.isEnabled());
        }, `${agentId}: Message composer ready`);
        return page;
      });

    const prompt = (page, agentId, phase, { complete = true } = {}) =>
      scope.track(async () => {
        signal?.throwIfAborted();
        assert(typeof agentId === "string" && agentId.length > 0);
        assert(typeof phase === "string" && phase.length > 0);
        const matchesResponse = (response) => {
          const url = new URL(response.url());
          const path = url.pathname.match(
            /^\/api\/app\/workspace\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/prompts$/u,
          );
          return (
            url.origin === gateway &&
            !url.search &&
            !url.hash &&
            response.request().method() === "POST" &&
            path !== null &&
            path[1] === encodeURIComponent(agentId)
          );
        };
        const response = await sendBrowserPrompt({
          page,
          composer: composer(page),
          phase,
          matchesResponse,
          poll,
        });
        const rawBody = await response.text();
        assert.equal(
          response.status(),
          202,
          "Original browser Prompt was not accepted",
        );
        const request = response.request();
        assert.equal(request.frame(), page.mainFrame());
        assert.equal(request.redirectedFrom(), null);
        assert.equal(request.url(), response.url());
        const input = request.postDataJSON();
        assert(typeof input.intentId === "string" && input.intentId.length > 0);
        assert.deepEqual(input.prompt, [{ type: "text", text: phase }]);
        const headers = await request.allHeaders();
        assert.equal(headers["idempotency-key"], input.intentId);
        assert.deepEqual(JSON.parse(rawBody), {
          operationId: input.intentId,
          acceptance: "bridge",
          phase: "dispatching",
        });
        const path = new URL(response.url()).pathname.match(
          /^\/api\/app\/workspace\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/prompts$/u,
        );
        assert(path);
        const receipt = {
          agentId,
          sessionId: decodeURIComponent(path[2]),
          phase,
          operationId: input.intentId,
        };
        // A missing or unavailable Trace never changes business acceptance.
        const traceID = response.headers()["x-antnest-trace-id"];
        receipts.push({
          ...receipt,
          ...(traceID === undefined ? {} : { traceID }),
        });
        if (complete) {
          const expected = `${phase} completed`;
          const answer = page
            .locator(".message-assistant .message-content")
            .filter({ hasText: expected })
            .first();
          await answer.waitFor({ state: "visible" });
          assert.equal((await answer.innerText()).trim(), expected);
        }
        signal?.throwIfAborted();
        return receipt;
      });

    return await scope.track(() =>
      work({ openAgent, prompt, closePage, receipts }),
    );
  });
}
