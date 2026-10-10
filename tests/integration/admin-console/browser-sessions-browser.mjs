// Built Console assets against browser API doubles. Real Gateway/Identity HTTPS
// acceptance is a separate integration batch.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durablePath } from "../../support/storage.mjs";
import {
  assertNoOverflow,
  prepareConsoleSession,
  withConsoleBrowser,
} from "./console-browser-harness.mjs";

const output = durablePath(
  fileURLToPath(
    new URL(
      "../../../artifacts/verification/console-browser-sessions/",
      import.meta.url,
    ),
  ),
);
const principal = {
  user_id: "admin-1",
  organization_id: "org-1",
  membership_id: "membership-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  system_role: "user",
  organization_role: "admin",
  active: true,
};
const member = {
  user: {
    id: "target-user",
    primary_email: "alex@example.test",
    system_role: "user",
    active: true,
  },
  membership: {
    id: "target-member",
    user_id: "target-user",
    organization_id: "org-1",
    email: "alex@example.test",
    display_name: "Alex",
    role: "member",
    source: "scim",
    active: true,
    created_at: "2026-10-11T00:00:00Z",
  },
};
const userAgent = "<img src=x onerror=alert(1)> Synthetic browser";

async function exercise(browser, origin, viewport, label) {
  const context = await browser.newContext({ viewport });
  await prepareConsoleSession(context, origin);
  const errors = [],
    unexpected = [],
    activity = [],
    revocations = [];
  let live = true,
    localPassword = false,
    passwordWrites = 0,
    validations = 0,
    directoryReads = 0;
  let othersRevoked = false,
    organizationRevoked = false,
    failRevoke = true;
  let hint = "synthetic-console-session",
    idleEnforced = false,
    lastActivity = Date.now();
  const issuedAt = new Date(lastActivity).toISOString();
  const absoluteExpiry = new Date(lastActivity + 43200000).toISOString();
  const metadata = () => ({
    expires_at: absoluteExpiry,
    idle_expires_at: new Date(lastActivity + 5000).toISOString(),
    activity_interval_ms: 1666,
  });
  const row = (id, organization, current) => ({
    id,
    organization_id: organization,
    organization_slug: organization,
    organization_name: organization === "org-1" ? "Engineering" : "Research",
    created_at: issuedAt,
    last_active_at: new Date(lastActivity).toISOString(),
    expires_at: metadata().expires_at,
    idle_expires_at: metadata().idle_expires_at,
    user_agent_hint: userAgent,
    current,
  });
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith("/api/")) return route.continue();
      const reply = (json, status = 200, headers = {}) =>
        route.fulfill({
          status,
          json,
          headers: { "cache-control": "no-store", ...headers },
        });
      if (path === "/api/session/login-methods") return reply({ methods: [] });
      if (idleEnforced && Date.now() - lastActivity >= 5000) live = false;
      if (!live)
        return reply(
          { code: "unauthenticated", message: "Session expired" },
          401,
        );
      if (path === "/api/session" && request.method() === "GET") {
        validations++;
        return reply({ principal, ...metadata() });
      }
      if (path === "/api/session/account")
        return reply({
          account: {
            user_id: principal.user_id,
            organization_id: principal.organization_id,
            membership_id: principal.membership_id,
            email: "admin@example.test",
            display_name: "Administrator",
            source: localPassword ? "local" : "oidc",
            local_password_available: localPassword,
          },
        });
      if (path === "/api/admin/directory") {
        directoryReads++;
        return reply({ users: [member], groups: [] });
      }
      if (request.method() === "POST")
        assert.equal(request.headers()["x-antnest-csrf-token"], hint);
      if (path === "/api/session/activity") {
        assert.deepEqual(request.postDataJSON(), {});
        lastActivity = Date.now();
        activity.push(lastActivity);
        return reply(metadata());
      }
      if (path === "/api/session/sessions") {
        assert.equal(url.searchParams.get("limit"), "50");
        if (url.searchParams.has("after_id")) {
          assert.equal(url.searchParams.get("after_id"), "public-current");
          return reply({ sessions: [row("public-other", "org-2", false)] });
        }
        return reply({
          sessions: [row("public-current", "org-1", true)],
          ...(othersRevoked ? {} : { next_after_id: "public-current" }),
        });
      }
      if (path === "/api/session/sessions/revoke") {
        const body = request.postDataJSON();
        assert.deepEqual(Object.keys(body), ["mode"]);
        assert(request.headers()["idempotency-key"]);
        revocations.push({ path, body });
        if (failRevoke) {
          failRevoke = false;
          return reply(
            { code: "unavailable", message: "Identity unavailable" },
            503,
          );
        }
        if (body.mode === "all") {
          live = false;
          return reply({ revoked_count: 1, current_revoked: true });
        }
        assert.equal(body.mode, "others");
        othersRevoked = true;
        return reply({ revoked_count: 1, current_revoked: false });
      }
      if (path === "/api/admin/directory/users/target-user/sessions")
        return reply({
          sessions: organizationRevoked
            ? []
            : [row("public-target", "org-1", false)],
        });
      if (path === "/api/admin/directory/users/target-user/sessions/revoke") {
        const body = request.postDataJSON();
        assert.deepEqual(body, {});
        revocations.push({ path, body });
        organizationRevoked = true;
        return reply({ revoked_count: 1, current_revoked: false });
      }
      if (path === "/api/session/password") {
        passwordWrites++;
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
        hint = "synthetic-console-rotated";
        return reply({ principal, ...metadata() }, 200, {
          "set-cookie": `antnest_csrf=${hint}; Path=/; SameSite=Strict`,
        });
      }
      unexpected.push(`${request.method()} ${path}`);
      return reply({ code: "unexpected_route" }, 503);
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      errors.push("Unexpected script dialog");
      await dialog.dismiss();
    });
    const openAccountAction = async (name) => {
      if (
        label === "mobile" &&
        (await page
          .getByRole("button", { name: "Open navigation" })
          .getAttribute("aria-expanded")) !== "true"
      )
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name }).click();
    };
    const openSessions = async () => {
      await openAccountAction("Manage browser sessions");
      return page.getByRole("dialog", { name: "Your browser sessions" });
    };
    await page.goto(`${origin}/#directory`);
    await page
      .getByRole("heading", { name: "Directory", exact: true })
      .waitFor();
    let dialog = await openSessions();
    assert.equal(
      await page.getByRole("button", { name: "Change local password" }).count(),
      0,
    );
    await dialog
      .getByText("Engineering · Current browser", { exact: true })
      .waitFor();
    await dialog.getByRole("button", { name: "Load more sessions" }).click();
    await dialog.getByText("Research", { exact: true }).waitFor();
    assert.equal(await dialog.locator("img").count(), 0);
    assert.equal(await dialog.getByText(userAgent, { exact: true }).count(), 2);
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-self-sessions.png`),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Sign out other sessions" })
      .click();
    await dialog.getByRole("button", { name: "Confirm revocation" }).click();
    await dialog.getByRole("alert").getByText("Identity unavailable").waitFor();
    await page.waitForTimeout(1800);
    assert.equal(revocations.length, 1, "503 must not replay a revocation");
    assert.equal(
      await dialog.getByText("Research", { exact: true }).count(),
      1,
    );
    await dialog.getByRole("button", { name: "Confirm revocation" }).click();
    await dialog.getByText("1 sessions revoked.", { exact: true }).waitFor();
    assert.equal(
      await dialog.getByText("Research", { exact: true }).count(),
      0,
    );
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    if (label === "mobile")
      await page.getByRole("button", { name: "Close navigation" }).click();
    await page
      .getByRole("button", { name: "Manage Alex browser sessions" })
      .filter({ visible: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Alex browser sessions" });
    await dialog
      .getByText("Only sessions in Engineering are shown and revoked.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await dialog
        .getByRole("button", { name: "Sign out other sessions" })
        .count(),
      0,
    );
    await dialog
      .getByRole("button", { name: "Revoke organization sessions" })
      .click();
    await dialog.getByRole("button", { name: "Confirm revocation" }).click();
    await dialog.getByText("No active sessions in this page.").waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-organization-revoked.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    dialog = await openSessions();
    await dialog.getByRole("button", { name: "Sign out all sessions" }).click();
    const beforeValidation = validations,
      beforeRevoke = revocations.length;
    await dialog.getByRole("button", { name: "Confirm revocation" }).focus();
    hint = "synthetic-console-other-tab";
    await context.addCookies([
      { name: "antnest_csrf", value: hint, url: origin, sameSite: "Strict" },
    ]);
    // The changed Cookie can make the genuine key input itself invalidate the
    // dialog before its click handler. Do not retry locating the stale button.
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "Directory", exact: true })
      .waitFor();
    assert(
      validations > beforeValidation,
      "changed delivery must require fresh validation",
    );
    assert.equal(
      revocations.length,
      beforeRevoke,
      "old confirmation must not mutate a replacement session",
    );
    dialog = await openSessions();
    await dialog.getByRole("button", { name: "Sign out all sessions" }).click();
    await dialog
      .getByText(
        "This includes the current browser. You will need to sign in again.",
      )
      .waitFor();
    await dialog.getByRole("button", { name: "Confirm revocation" }).click();
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();

    live = true;
    localPassword = true;
    lastActivity = Date.now();
    await page.reload();
    await page
      .getByRole("heading", { name: "Directory", exact: true })
      .waitFor();
    await openAccountAction("Change local password");
    dialog = page.getByRole("dialog", { name: "Local password" });
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
    const previousReads = directoryReads,
      previousValidations = validations;
    await dialog.getByRole("button", { name: "Update password" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "Directory", exact: true })
      .waitFor();
    assert(
      directoryReads > previousReads,
      "same-user password replacement must remount private page",
    );
    assert(
      validations > previousValidations,
      "password transition must validate current Cookies",
    );
    assert.equal(passwordWrites, 2);
    assert.equal(
      await page.evaluate(
        async () => (await (await fetch("/api/session")).json()).expires_at,
      ),
      absoluteExpiry,
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
      hint,
    ])
      assert(!storage.includes(secret));

    // A five-second idle fixture makes a missed trailing report observable while
    // genuine pointer input continues; ordinary browser reads never touch it.
    idleEnforced = true;
    lastActivity = Date.now();
    await page.reload();
    await page
      .getByRole("heading", { name: "Directory", exact: true })
      .waitFor();
    const beforeIdle = activity.length;
    await page.evaluate(() => {
      document.dispatchEvent(new Event("input"));
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(1800);
    assert.equal(
      activity.length,
      beforeIdle,
      "programmatic events and passive page must not touch idle",
    );
    for (let index = 0; index < 14; index++) {
      await page.mouse.move(100 + index * 5, 100);
      await page.waitForTimeout(400);
    }
    assert(
      live,
      "continuous genuine input must preserve the short-idle fixture",
    );
    assert(
      activity.length >= beforeIdle + 3,
      "input must produce leading and dirty trailing reports",
    );
    await page.waitForTimeout(1800);
    const lastTouch = lastActivity;
    assert.equal(
      await page.evaluate(
        async () => (await (await fetch("/api/session")).json()).expires_at,
      ),
      absoluteExpiry,
    );
    assert.equal(
      lastActivity,
      lastTouch,
      "ordinary validation must not record activity",
    );
    const quietReports = activity.length;
    await page.waitForTimeout(5200);
    assert.equal(
      activity.length,
      quietReports,
      "no periodic reports after input stops",
    );
    assert.equal(
      await page.evaluate(async () => (await fetch("/api/session")).status),
      401,
    );
    await page.mouse.move(200, 120);
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    return {
      viewport: label,
      oidc_controls: true,
      pagination_and_plaintext: true,
      organization_scope: true,
      unavailable_no_replay: true,
      delivery_revalidation: true,
      self_revocation: true,
      password_rotation: true,
      input_and_idle_5s: true,
      browser_errors: errors.length,
    };
  } finally {
    await context.close();
  }
}

console.log(
  JSON.stringify({ results: await withConsoleBrowser(output, exercise) }),
);
