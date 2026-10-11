// Production SSR/client assets with explicit Gateway browser API doubles.
// Real Identity/Gateway acceptance belongs to the separate HTTPS integration batch.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { loadWorkspaceDocument } from "../../../services/agent-ui/web/server/dist/ssr-assets.js";
import {
  createTestWorkspaceHttpServer,
  testBrowserContext,
} from "./auth-fixture.mjs";
import { assertWcagPage } from "../../support/agent-ui/accessibility.mjs";

const principal = {
  user_id: "user-1",
  organization_id: "org-1",
  membership_id: "member-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  system_role: "user",
  organization_role: "member",
  active: true,
};
const userAgent = "<img src=x onerror=alert(1)> Synthetic browser";
const output = fileURLToPath(
  new URL(
    "../../../artifacts/verification/issue-61/agent-ui-browser/sessions/",
    import.meta.url,
  ),
);

async function withWorkspace(viewport, exercise) {
  const state = {
    live: true,
    localPassword: false,
    failRevoke: true,
    othersRevoked: false,
    hint: "synthetic-workspace-session",
    validations: 0,
    bootstraps: 0,
    passwordWrites: 0,
    revocations: [],
    activity: [],
    idleEnforced: false,
    lastActivity: Date.now(),
    absoluteExpiry: new Date(Date.now() + 43_200_000).toISOString(),
  };
  const metadata = () => ({
    expires_at: state.absoluteExpiry,
    idle_expires_at: new Date(
      state.lastActivity + (state.idleEnforced ? 5000 : 1_800_000),
    ).toISOString(),
    activity_interval_ms: 1666,
  });
  const row = (id, organization, current) => ({
    id,
    organization_id: organization,
    organization_slug: organization,
    organization_name: organization === "org-1" ? "Engineering" : "Research",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    last_active_at: new Date(state.lastActivity).toISOString(),
    expires_at: metadata().expires_at,
    idle_expires_at: metadata().idle_expires_at,
    user_agent_hint: userAgent,
    current,
  });
  const server = createTestWorkspaceHttpServer(
    {
      async handle(request) {
        if (new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap")
          return null;
        state.bootstraps++;
        return Response.json({
          principal: {
            userId: "user-1",
            organizationId: "org-1",
            organizationSlug: "engineering",
            organizationName: "Engineering",
            administrator: false,
          },
          agents: [],
          renderedAt: new Date().toISOString(),
          bridgeEpoch: "epoch-1",
        });
      },
    },
    await loadWorkspaceDocument(),
  );
  let browser;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    browser = await chromium.launch({ headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await testBrowserContext(browser, {
      viewport,
      extraHTTPHeaders: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-administrator": "false",
        "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
        "x-antnest-organization-name": "RW5naW5lZXJpbmc",
      },
    });
    await context.addCookies([
      {
        name: "antnest_csrf",
        value: state.hint,
        url: origin,
        sameSite: "Strict",
      },
    ]);
    const unexpected = [],
      errors = [];
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      if (url.origin !== origin) {
        unexpected.push(url.href);
        return route.abort();
      }
      if (path === "/")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Sign in</title><h1>Sign in</h1>",
        });
      if (!path.startsWith("/api/session")) return route.fallback();
      const reply = (json, status = 200, headers = {}) =>
        route.fulfill({
          status,
          json,
          headers: { "cache-control": "no-store", ...headers },
        });
      if (state.idleEnforced && Date.now() - state.lastActivity >= 5000)
        state.live = false;
      if (!state.live)
        return reply(
          { code: "unauthenticated", message: "Session expired" },
          401,
        );
      if (path === "/api/session" && request.method() === "GET") {
        state.validations++;
        return reply({ principal, ...metadata() });
      }
      if (request.method() === "POST")
        assert.equal(request.headers()["x-antnest-csrf-token"], state.hint);
      if (path === "/api/session/activity") {
        assert.equal(request.method(), "POST");
        assert.deepEqual(request.postDataJSON(), {});
        state.lastActivity = Date.now();
        state.activity.push(state.lastActivity);
        return reply(metadata());
      }
      if (path === "/api/session/account")
        return reply({
          account: {
            user_id: "user-1",
            organization_id: "org-1",
            membership_id: "member-1",
            email: "alex@example.test",
            display_name: "Alex",
            source: state.localPassword ? "local" : "scim",
            local_password_available: state.localPassword,
          },
        });
      if (
        path === "/api/session/external-identities" &&
        request.method() === "GET"
      )
        return reply({ bindings: [], notices: [] });
      if (path === "/api/session/sessions") {
        assert.equal(url.searchParams.get("limit"), "50");
        if (url.searchParams.has("after_id")) {
          assert.equal(url.searchParams.get("after_id"), "public-current");
          return reply({ sessions: [row("public-other", "org-2", false)] });
        }
        return reply({
          sessions: [row("public-current", "org-1", true)],
          ...(state.othersRevoked ? {} : { next_after_id: "public-current" }),
        });
      }
      if (path === "/api/session/sessions/revoke") {
        const body = request.postDataJSON();
        assert.deepEqual(Object.keys(body), ["mode"]);
        assert.match(request.headers()["idempotency-key"], /^[0-9a-f-]{36}$/u);
        state.revocations.push(body);
        if (state.failRevoke) {
          state.failRevoke = false;
          return reply(
            { code: "unavailable", message: "Identity unavailable" },
            503,
          );
        }
        assert(["all", "others"].includes(body.mode));
        if (body.mode === "all") {
          state.live = false;
          return reply({ revoked_count: 1, current_revoked: true });
        }
        state.othersRevoked = true;
        return reply({ revoked_count: 1, current_revoked: false });
      }
      if (path === "/api/session/password") {
        state.passwordWrites++;
        const body = request.postDataJSON();
        assert.equal(body.new_password, "new-password-canary");
        if (body.current_password === "wrong-password")
          return reply(
            {
              code: "invalid_current_password",
              message: "Current password is incorrect",
            },
            400,
          );
        assert.equal(body.current_password, "current-password-canary");
        state.hint = "synthetic-workspace-rotated";
        return reply({ principal, ...metadata() }, 200, {
          "set-cookie": `antnest_csrf=${state.hint}; Path=/; SameSite=Strict`,
        });
      }
      unexpected.push(`${request.method()} ${path}`);
      return reply({ code: "unexpected_route" }, 503);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      errors.push("Unexpected script dialog");
      await dialog.dismiss();
    });
    await exercise({ page, context, origin, state });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

async function openAccount(page) {
  await page
    .getByRole("button", { name: "Account and sessions", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Account and sessions",
    exact: true,
  });
  await dialog
    .getByText("This browser · Engineering", { exact: true })
    .waitFor();
  return dialog;
}

for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test(
    `Workspace ${label} account controls retain OIDC access, revoke safely and replace password sessions`,
    { timeout: 60_000 },
    async () => {
      await withWorkspace(
        viewport,
        async ({ page, context, origin, state }) => {
          await page.goto(`${origin}/workspace/`);
          await page.getByText("No Agent available", { exact: true }).waitFor();
          let dialog = await openAccount(page);
          assert.equal(
            await dialog
              .getByRole("heading", { name: "Change password", exact: true })
              .count(),
            0,
          );
          await dialog
            .getByRole("button", { name: "Load more sessions" })
            .click();
          await dialog
            .getByText("Other browser · Research", { exact: true })
            .waitFor();
          assert.equal(await dialog.locator("img").count(), 0);
          assert.equal(
            await dialog.getByText(userAgent, { exact: true }).count(),
            2,
          );
          assert(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          );
          assert(
            await dialog.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          );
          await assertWcagPage(page);
          mkdirSync(output, { recursive: true });
          await page.screenshot({
            path: `${output}/${label}-account.png`,
            fullPage: true,
          });
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          assert.equal(
            await page.evaluate(() =>
              document.activeElement?.textContent?.trim(),
            ),
            "Account and sessions",
          );
          dialog = await openAccount(page);
          await dialog
            .getByRole("button", {
              name: "Sign out other sessions",
              exact: true,
            })
            .click();
          await dialog
            .getByRole("button", { name: "Confirm sign out other sessions" })
            .click();
          await dialog
            .getByRole("alert")
            .getByText("Identity unavailable")
            .waitFor();
          await page.waitForTimeout(1800);
          assert.equal(
            state.revocations.length,
            1,
            "503 must not automatically replay revocation",
          );
          await dialog
            .getByRole("button", { name: "Confirm sign out other sessions" })
            .click();
          await dialog
            .getByText("1 session was signed out.", { exact: true })
            .waitFor();
          assert.equal(
            await dialog
              .getByRole("button", { name: "Load more sessions" })
              .count(),
            0,
          );
          await dialog
            .getByRole("button", { name: "Sign out all sessions", exact: true })
            .click();
          await dialog
            .getByRole("button", { name: "Confirm sign out all sessions" })
            .focus();
          const before = state.revocations.length,
            reads = state.validations;
          state.hint = "synthetic-workspace-other-tab";
          await context.addCookies([
            {
              name: "antnest_csrf",
              value: state.hint,
              url: origin,
              sameSite: "Strict",
            },
          ]);
          await page.keyboard.press("Enter");
          await dialog.waitFor({ state: "hidden" });
          await page.getByText("No Agent available", { exact: true }).waitFor();
          assert(state.validations > reads);
          assert.equal(
            state.revocations.length,
            before,
            "an old confirmation must not revoke a replacement",
          );
          state.localPassword = true;
          dialog = await openAccount(page);
          await dialog
            .getByLabel("Current password", { exact: true })
            .fill("wrong-password");
          await dialog
            .getByLabel("New password", { exact: true })
            .fill("new-password-canary");
          await dialog
            .getByLabel("Confirm new password", { exact: true })
            .fill("new-password-canary");
          await dialog.getByRole("button", { name: "Update password" }).click();
          await dialog
            .getByRole("alert")
            .getByText("Current password is incorrect")
            .waitFor();
          await dialog
            .getByLabel("Current password", { exact: true })
            .fill("current-password-canary");
          const beforePassword = {
            reads: state.validations,
            bootstraps: state.bootstraps,
          };
          await dialog.getByRole("button", { name: "Update password" }).click();
          await dialog.waitFor({ state: "hidden" });
          await page.getByText("No Agent available", { exact: true }).waitFor();
          assert(state.validations > beforePassword.reads);
          assert(
            state.bootstraps > beforePassword.bootstraps,
            "same-user password replacement reloads private state",
          );
          assert.equal(state.passwordWrites, 2);
          assert.equal(
            await page.evaluate(
              async () =>
                (await (await fetch("/api/session")).json()).expires_at,
            ),
            state.absoluteExpiry,
          );
          const storage = await page.evaluate(() =>
            JSON.stringify({
              local: { ...localStorage },
              session: { ...sessionStorage },
            }),
          );
          for (const secret of [
            "new-password-canary",
            "current-password-canary",
            state.hint,
          ])
            assert(!storage.includes(secret));
          dialog = await openAccount(page);
          await dialog
            .getByRole("button", { name: "Sign out all sessions", exact: true })
            .click();
          await dialog
            .getByRole("button", { name: "Confirm sign out all sessions" })
            .click();
          await page
            .getByRole("heading", { name: "Sign in", exact: true })
            .waitFor();
          assert.equal(new URL(page.url()).pathname, "/");
          assert.equal(new URL(page.url()).search, "");
        },
      );
    },
  );
}

test(
  "Workspace genuine input renews idle while passive reads expire and preserve the login return route",
  { timeout: 45_000 },
  async () => {
    await withWorkspace(
      { width: 1280, height: 900 },
      async ({ page, origin, state }) => {
        state.idleEnforced = true;
        state.lastActivity = Date.now();
        await page.goto(`${origin}/workspace/`);
        await page.getByText("No Agent available", { exact: true }).waitFor();
        await page.evaluate(() => {
          document.dispatchEvent(new Event("input"));
          window.dispatchEvent(new Event("scroll"));
          window.dispatchEvent(new Event("focus"));
        });
        await page.waitForTimeout(1800);
        assert.equal(
          state.activity.length,
          0,
          "synthetic events and initial reads must not touch idle",
        );
        for (let index = 0; index < 14; index++) {
          await page.mouse.move(100 + index * 5, 100);
          await page.waitForTimeout(400);
        }
        assert(state.live);
        assert(
          state.activity.length >= 3,
          "leading and dirty trailing input must keep the short-idle session live",
        );
        await page.waitForTimeout(1800);
        const reports = state.activity.length,
          touched = state.lastActivity;
        for (let index = 0; index < 6; index++) {
          await page.evaluate(async () => {
            await fetch("/api/session");
            await fetch("/api/app/workspace/v1/bootstrap");
          });
          await page.waitForTimeout(900);
        }
        assert.equal(state.lastActivity, touched);
        assert.equal(
          state.activity.length,
          reports,
          "background reads must not start periodic activity reports",
        );
        assert.equal(
          await page.evaluate(async () => (await fetch("/api/session")).status),
          401,
        );
        await page.mouse.move(210, 125);
        await page
          .getByRole("heading", { name: "Sign in", exact: true })
          .waitFor();
        assert.equal(
          new URL(page.url()).searchParams.get("return_to"),
          "/workspace/",
        );
      },
    );
  },
);
