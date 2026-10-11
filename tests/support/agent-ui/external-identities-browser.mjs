// Real Agent UI SSR/assets/Workspace API, explicit Gateway browser-session double.
// The caller supplies the owning harness's signing authority; this module never
// creates a second JWKS fixture or forwards credentials to a different origin.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { assertWcagPage } from "./accessibility.mjs";
import {
  installRevocationObserver,
  readRevocationObservation,
  assertRevocationStoppedRequests,
  assertOnlyPendingActivity,
} from "./revocation-observer.mjs";

const path = "/api/session/external-identities";
const principal = {
  user_id: "user-1",
  organization_id: "org-1",
  membership_id: "membership-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  system_role: "user",
  organization_role: "member",
  active: true,
};
const hints = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-administrator": "false",
  "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
  "x-antnest-organization-name": "RW5naW5lZXJpbmc",
};
const opaque = "  <img src=x onerror=alert(1)> é 😀  ";
const details = {
  provider_id: "provider-other",
  provider_name: "workforce",
  provider_display_name: "Workforce",
  organization_id: "org-2",
  organization_slug: "research",
  organization_name: "Research",
  membership_id: "membership-2",
  subject: opaque,
  method: "scim",
  created_at: "2026-10-10T00:00:00Z",
};
const binding = {
  ...details,
  id: "binding-01-other",
  provider_enabled: false,
  bound_at: "2026-10-11T01:00:00Z",
  revoked_at: null,
};
const currentBinding = {
  ...binding,
  id: "binding-02-current",
  provider_id: "provider-current",
  provider_name: "current",
  provider_display_name: "Current SSO",
  organization_id: "org-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  membership_id: "membership-1",
  subject: "current subject",
  provider_enabled: true,
};
const historicalNotice = {
  ...details,
  id: "notice-01-old",
  binding_id: "historical-binding",
  provider_id: "deleted-provider",
  provider_name: "historical",
  provider_display_name: "Historical provider",
  organization_id: "deleted-org",
  organization_slug: "historical",
  organization_name: "Historical organization",
  membership_id: "deleted-membership",
  subject: "historical subject",
  method: "auto",
};
const secondNotice = {
  ...details,
  id: "notice-03-second",
  binding_id: binding.id,
  subject: "second notice",
};

async function waitForGate(promise, label) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyExternalIdentitiesBrowser({
  base,
  output,
  headersForRequest,
  signal,
}) {
  signal?.throwIfAborted();
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const stop = () => {
    void browser.close().catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  const reports = [];
  try {
    signal?.throwIfAborted();
    for (const [label, viewport] of [
      ["desktop", { width: 1280, height: 900 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({ viewport });
      const state = {
        live: true,
        failAck: true,
        failRead: false,
        unbound: false,
        newNotice: false,
        acknowledged: new Set(),
        reads: [],
        writes: [],
        keys: new Set(),
        privateAfterRevocation: [],
        revocationCommitted: Promise.withResolvers(),
        revocationReply: Promise.withResolvers(),
        overlappingActivity: Promise.withResolvers(),
        activityReply: Promise.withResolvers(),
        activityCancelled: Promise.withResolvers(),
        heldActivity: undefined,
      };
      const unexpected = [],
        errors = [];
      const metadata = {
        expires_at: new Date(Date.now() + 43_200_000).toISOString(),
        idle_expires_at: new Date(Date.now() + 1_800_000).toISOString(),
        activity_interval_ms: 1666,
      };
      try {
        await installRevocationObserver(
          context,
          path + "/" + currentBinding.id,
        );
        await context.addCookies([
          {
            name: "antnest_csrf",
            value: "external-identities-test",
            url: base,
            sameSite: "Strict",
          },
        ]);
        await context.route("**/*", async (route) => {
          const request = route.request(),
            url = new URL(request.url());
          if (url.origin !== base) {
            unexpected.push(url.href);
            return route.abort();
          }
          if (url.pathname === "/")
            return route.fulfill({
              contentType: "text/html",
              body: "<!doctype html><html lang=en><title>Sign in</title><h1>Sign in</h1></html>",
            });
          if (!url.pathname.startsWith("/api/session")) {
            if (!state.live && url.pathname.startsWith("/api/"))
              state.privateAfterRevocation.push(request);
            return route.continue({
              headers: headersForRequest(
                { ...request.headers(), ...hints },
                "edge-gateway",
                request.url(),
              ),
            });
          }
          const reply = (json, status = 200) =>
            route.fulfill({
              status,
              json,
              headers: { "cache-control": "no-store" },
            });
          if (!state.live) {
            state.privateAfterRevocation.push(request);
            if (
              url.pathname === "/api/session/activity" &&
              request.method() === "POST"
            ) {
              state.heldActivity = request;
              state.overlappingActivity.resolve();
              // Keep the 401 pending until the successful unbind has been
              // consumed, so a racing 401 cannot hide that result's handling.
              await state.activityReply.promise;
              if (request.failure()) return;
            }
            return reply(
              { code: "unauthenticated", message: "Session ended" },
              401,
            );
          }
          if (request.method() !== "GET")
            assert.equal(
              request.headers()["x-antnest-csrf-token"],
              "external-identities-test",
            );
          if (url.pathname === "/api/session" && request.method() === "GET")
            return reply({ principal, ...metadata });
          if (
            url.pathname === "/api/session/activity" &&
            request.method() === "POST"
          )
            return reply(metadata);
          if (url.pathname === "/api/session/account")
            return reply({
              account: {
                user_id: principal.user_id,
                organization_id: principal.organization_id,
                membership_id: principal.membership_id,
                email: "member@example.test",
                display_name: "Member",
                source: "scim",
                local_password_available: false,
              },
            });
          if (url.pathname === "/api/session/sessions")
            return reply({ sessions: [] });
          if (url.pathname === path && request.method() === "GET") {
            state.reads.push(url.pathname + url.search);
            assert.equal(url.searchParams.get("limit"), "50");
            assert.equal(
              url.searchParams.has("after_id") &&
                url.searchParams.has("notice_after_id"),
              false,
            );
            if (state.failRead) {
              state.failRead = false;
              return reply(
                {
                  code: "unavailable",
                  message: "Inventory temporarily unavailable",
                },
                503,
              );
            }
            const bindingPage = url.searchParams.get("after_id"),
              noticePage = url.searchParams.get("notice_after_id");
            const allBindings = [
              {
                ...binding,
                revoked_at: state.unbound ? "2026-10-11T02:00:00Z" : null,
              },
              currentBinding,
            ];
            const allNotices = [
              historicalNotice,
              ...(state.newNotice
                ? [
                    {
                      ...historicalNotice,
                      id: "notice-02-new",
                      subject: "new notice after restore",
                    },
                  ]
                : []),
              secondNotice,
            ].filter((row) => !state.acknowledged.has(row.id));
            const pageOf = (rows, after) => {
              const remaining = rows.filter((row) => !after || row.id > after);
              return {
                rows: remaining.slice(0, 1),
                next: remaining.length > 1 ? remaining[0].id : undefined,
              };
            };
            const bindings = pageOf(allBindings, bindingPage),
              notices = pageOf(allNotices, noticePage);
            return reply({
              bindings: bindings.rows,
              notices: notices.rows,
              ...(bindings.next ? { next_after_id: bindings.next } : {}),
              ...(notices.next ? { next_notice_after_id: notices.next } : {}),
            });
          }
          if (
            url.pathname.startsWith(path + "/") &&
            ["POST", "DELETE"].includes(request.method())
          ) {
            const key = request.headers()["idempotency-key"];
            assert.match(key, /^[0-9a-f-]{36}$/u);
            assert(
              !state.keys.has(key),
              "Every explicit mutation gets a fresh key",
            );
            state.keys.add(key);
            const body = request.postDataJSON();
            state.writes.push({
              path: url.pathname,
              method: request.method(),
              body,
            });
            if (url.pathname === path + "/notices/acknowledge") {
              assert.equal(request.method(), "POST");
              assert.deepEqual(Object.keys(body), ["notice_ids"]);
              assert.equal(body.notice_ids.length, 1);
              assert(
                [
                  historicalNotice.id,
                  secondNotice.id,
                  "notice-02-new",
                ].includes(body.notice_ids[0]),
              );
              if (state.failAck) {
                state.failAck = false;
                return reply(
                  {
                    code: "unavailable",
                    message: "Acknowledgment temporarily unavailable",
                  },
                  503,
                );
              }
              state.acknowledged.add(body.notice_ids[0]);
              // Another browser may already have acknowledged the old notice.
              return reply({
                acknowledged_count:
                  body.notice_ids[0] === historicalNotice.id ? 0 : 1,
              });
            }
            assert.equal(request.method(), "DELETE");
            assert.deepEqual(Object.keys(body), ["allow_lockout"]);
            if (url.pathname === path + "/" + binding.id) {
              assert.equal(body.allow_lockout, false);
              state.unbound = true;
              return reply({ revoked_count: 1, current_revoked: false });
            }
            assert.equal(url.pathname, path + "/" + currentBinding.id);
            if (!body.allow_lockout)
              return reply(
                {
                  code: "external_identity_last_method",
                  message: "Last available login method",
                },
                409,
              );
            state.live = false;
            state.revocationCommitted.resolve();
            await state.revocationReply.promise;
            return reply({ revoked_count: 2, current_revoked: true });
          }
          unexpected.push(`${request.method()} ${url.pathname}`);
          return reply({ code: "unexpected_route" }, 503);
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("requestfailed", (request) => {
          if (request === state.heldActivity) state.activityCancelled.resolve();
        });
        page.on("dialog", async (dialog) => {
          errors.push("Unexpected script dialog");
          await dialog.dismiss();
        });
        await page.goto(base + "/workspace/");
        await page.getByText("No Agent available", { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Review external login notices" })
          .click();
        const panel = page.getByRole("dialog", {
          name: "Account and sessions",
          exact: true,
        });
        await panel
          .getByRole("heading", { name: "External logins", exact: true })
          .waitFor();
        await panel.getByText("historical subject", { exact: true }).waitFor();
        assert.equal(await panel.locator("code").first().textContent(), opaque);
        assert.equal(await panel.locator("img").count(), 0);
        assert.equal(
          await panel
            .getByRole("heading", { name: "Change password", exact: true })
            .count(),
          0,
        );
        await panel.getByRole("button", { name: "Load more bindings" }).click();
        await panel.getByText("current subject", { exact: true }).waitFor();
        await panel.getByText("historical subject", { exact: true }).waitFor();
        await panel.getByRole("button", { name: "Load more notices" }).click();
        await panel.getByText("second notice", { exact: true }).waitFor();
        await panel.getByText("current subject", { exact: true }).waitFor();
        await assertWcagPage(page);
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        assert(
          await panel.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        );
        await page.screenshot({
          path: `${output}/${label}-external-identities.png`,
          fullPage: true,
        });
        const acknowledge = panel.getByRole("button", {
          name: "Acknowledge Historical provider in Historical organization",
          exact: true,
        });
        await acknowledge.click();
        await panel
          .getByRole("alert")
          .getByText("Acknowledgment temporarily unavailable", { exact: true })
          .waitFor();
        await page.waitForTimeout(250);
        assert.equal(state.writes.length, 1, "Failed ACK must not replay");
        await panel.getByText("historical subject", { exact: true }).waitFor();
        const readsBeforeAck = state.reads.length;
        await acknowledge.click();
        await acknowledge.waitFor({ state: "hidden" });
        await panel.getByText("second notice", { exact: true }).waitFor();
        assert.equal(
          state.reads.length,
          readsBeforeAck,
          "ACK does not reread inventory",
        );
        await panel
          .getByRole("button", { name: "Unbind Workforce", exact: true })
          .click();
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.textContent?.trim(),
          ),
          "Review external login notices",
          "Closing the account returns focus to the notice trigger",
        );
        await page
          .getByRole("button", { name: "Review external login notices" })
          .click();
        assert.equal(
          await panel
            .getByRole("button", { name: "Confirm unbind", exact: true })
            .count(),
          0,
        );
        const lastAck = panel.getByRole("button", {
          name: "Acknowledge Workforce in Research",
          exact: true,
        });
        await lastAck.click();
        await lastAck.waitFor({ state: "hidden" });
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        assert.equal(
          await page
            .getByRole("button", { name: "Review external login notices" })
            .count(),
          0,
        );
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.textContent?.trim(),
          ),
          "Account and sessions",
          "Removing the last notice restores focus to the surviving account control",
        );
        await page
          .getByRole("button", { name: "Account and sessions", exact: true })
          .click();
        state.newNotice = true;
        await panel
          .getByRole("button", { name: "Refresh external logins" })
          .click();
        await panel
          .getByText("new notice after restore", { exact: true })
          .waitFor();
        assert.equal(
          await panel.getByText("historical subject", { exact: true }).count(),
          0,
        );
        state.failRead = true;
        await panel
          .getByRole("button", { name: "Refresh external logins" })
          .click();
        await panel
          .getByRole("alert")
          .getByText("Inventory temporarily unavailable", { exact: true })
          .waitFor();
        await panel
          .getByText("new notice after restore", { exact: true })
          .waitFor();
        await panel
          .getByRole("button", { name: "Unbind Workforce", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "Confirm unbind", exact: true })
          .click();
        await panel
          .getByText("External login unbound. 1 session revoked.", {
            exact: true,
          })
          .waitFor();
        await panel
          .getByRole("button", { name: "Unbind Workforce", exact: true })
          .waitFor({ state: "hidden" });
        await panel.getByRole("button", { name: "Load more bindings" }).click();
        await panel
          .getByRole("button", { name: "Unbind Current SSO", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "Confirm unbind", exact: true })
          .click();
        const lockout = panel.getByRole("button", {
          name: "Unbind and accept lockout",
          exact: true,
        });
        await lockout.waitFor();
        assert.deepEqual(
          state.writes
            .filter((item) => item.method === "DELETE")
            .map((item) => item.body),
          [{ allow_lockout: false }, { allow_lockout: false }],
        );
        await page.screenshot({
          path: `${output}/${label}-lockout.png`,
          fullPage: true,
        });
        await lockout.click();
        await waitForGate(state.revocationCommitted.promise, "unbind commit");
        // A genuine input while the reply is held must remain observable as
        // activity; the browser does not yet know its session was revoked.
        await page.mouse.move(5, 5);
        await waitForGate(
          state.overlappingActivity.promise,
          "overlapping input activity",
        );
        const pendingActivity = state.heldActivity;
        state.revocationReply.resolve();
        await page
          .getByRole("heading", { name: "Sign in", exact: true })
          .waitFor();
        await waitForGate(
          state.activityCancelled.promise,
          "old activity cancellation",
        );
        state.activityReply.resolve();
        const revocationObservation = await readRevocationObservation(page);
        // The browser snapshot proves consumption order. The route-side
        // collection also covers dispatch between that snapshot and closure.
        await context.close();
        assertRevocationStoppedRequests(revocationObservation);
        assertOnlyPendingActivity(
          state.privateAfterRevocation,
          pendingActivity,
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        reports.push({
          viewport: label,
          inventory_requests: state.reads,
          mutations: state.writes,
          revocation_observation: revocationObservation,
          pending_revocation_activity_requests:
            state.privateAfterRevocation.length,
          pending_activity_cancelled: Boolean(pendingActivity.failure()),
          current_revoked_extra_private_requests: 0,
          browser_errors: errors,
          unexpected_requests: unexpected,
        });
      } finally {
        state.revocationReply.resolve();
        state.activityReply.resolve();
        await context.close();
      }
      signal?.throwIfAborted();
    }
    await writeFile(
      `${output}/admission.json`,
      JSON.stringify(
        {
          evidence:
            "real Agent UI SSR/assets/Workspace API; Gateway browser API double; real Identity integration pending",
          reports,
        },
        null,
        2,
      ) + "\n",
    );
    return reports;
  } finally {
    signal?.removeEventListener("abort", stop);
    await browser.close();
  }
}
