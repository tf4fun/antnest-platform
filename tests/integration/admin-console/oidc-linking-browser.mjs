// Built Console assets and API doubles; real Identity admission is separate.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoOverflow,
  consoleSessionMetadata,
  prepareConsoleSession,
} from "./console-browser-harness.mjs";

const output = fileURLToPath(
  new URL(
    "../../../artifacts/verification/console-browser-sessions/",
    import.meta.url,
  ),
);
const self = "/api/session/external-identities";
const organization =
  "/api/admin/directory/memberships/target-member/external-identities";
const chooser = "/api/admin/directory/identity-providers";
const configuration = "/api/admin/provisioning/oidc-providers";
const tokenPath = "/api/admin/provisioning/scim-tokens";
const opaqueSubject = "  <img src=x onerror=alert(1)> é 😀  ";
const timestamp = "2026-10-11T00:00:00Z";
const binding = {
  id: "binding-1",
  provider_id: "provider-1",
  provider_name: "workforce",
  provider_display_name: "Workforce",
  organization_id: "org-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  membership_id: "member-1",
  subject: opaqueSubject,
  method: "scim",
  provider_enabled: false,
  created_at: timestamp,
  bound_at: "2026-10-11T01:00:00Z",
  revoked_at: null,
};
const otherBinding = {
  ...binding,
  id: "binding-2",
  provider_display_name: "Research login",
  organization_id: "org-2",
  organization_name: "Research",
  membership_id: "member-2",
};
const notice = {
  id: "notice-1",
  binding_id: "historical-binding",
  provider_id: "old-provider",
  provider_name: "old",
  provider_display_name: "Previous provider",
  organization_id: "old-org",
  organization_slug: "historical",
  organization_name: "Historical organization",
  membership_id: "old-member",
  subject: "historical subject",
  method: "auto",
  created_at: timestamp,
};

export async function exerciseExternalIdentities(
  browser,
  origin,
  viewport,
  label,
) {
  const context = await browser.newContext({ viewport });
  await prepareConsoleSession(context, origin);
  let live = true,
    systemAdministrator = false,
    restored = false,
    acknowledged = false,
    selfReads = 0;
  const errors = [],
    unexpected = [],
    writes = [];
  const principal = {
    user_id: "admin-1",
    organization_id: "org-1",
    membership_id: "member-1",
    organization_slug: "engineering",
    organization_name: "Engineering",
    organization_role: "admin",
    active: true,
  };
  let provider = {
    name: "workforce",
    display_name: "Workforce",
    issuer: "https://idp.example.test",
    client_id: "client",
    scopes: ["openid", "email"],
    enabled: false,
    revision: 1,
    authorization_endpoint: "https://idp.example.test/authorize",
    token_endpoint: "https://idp.example.test/token",
    token_endpoint_auth_method: "client_secret_basic",
    id_token_signing_algs: ["RS256"],
    jwks_uri: "https://idp.example.test/jwks",
    created_at: timestamp,
    updated_at: timestamp,
    link_policy: "verified_email",
    link_domains: [],
    authoritative: false,
    link_policy_review_required: true,
  };
  let tokens = [
    {
      id: "token-1",
      name: "Directory only",
      scopes: ["scim:read"],
      created_at: timestamp,
      oidc_provider_id: null,
    },
  ];
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname,
        method = request.method();
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith("/api/")) return route.continue();
      const reply = (json, status = 200) =>
        route.fulfill({
          status,
          json,
          headers: { "cache-control": "no-store" },
        });
      if (path === "/api/session/login-methods") return reply({ methods: [] });
      if (!live)
        return reply(
          { code: "unauthenticated", message: "Session expired" },
          401,
        );
      if (path === "/api/session")
        return reply({
          principal: {
            ...principal,
            system_role: systemAdministrator ? "admin" : "user",
          },
          ...consoleSessionMetadata,
        });
      if (path === "/api/session/account")
        return reply({
          account: {
            ...principal,
            email: "admin@example.test",
            display_name: "Administrator",
            source: "oidc",
            local_password_available: false,
          },
        });
      if (["POST", "DELETE"].includes(method)) {
        assert.equal(
          request.headers()["x-antnest-csrf-token"],
          "synthetic-console-session",
        );
        if (path !== "/api/session/activity") {
          assert(request.headers()["idempotency-key"]);
          writes.push({ path, method, body: request.postDataJSON() });
        }
      }
      if (path === "/api/session/activity")
        return reply(consoleSessionMetadata);
      if (path === "/api/admin/directory")
        return reply({
          users: [
            {
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
                created_at: timestamp,
              },
            },
          ],
          groups: [],
        });
      if (path === self && method === "GET") {
        selfReads++;
        assert.equal(url.searchParams.get("limit"), "50");
        if (url.searchParams.has("after_id")) {
          assert.equal(url.searchParams.get("after_id"), "binding-1");
          assert.equal(url.searchParams.has("notice_after_id"), false);
          return reply({ bindings: [otherBinding], notices: [] });
        }
        if (url.searchParams.has("notice_after_id")) {
          assert.equal(url.searchParams.get("notice_after_id"), "notice-1");
          return reply({
            bindings: [],
            notices: [{ ...notice, id: "notice-2", subject: "second notice" }],
          });
        }
        return reply({
          bindings: [binding],
          next_after_id: "binding-1",
          notices: [
            acknowledged
              ? {
                  ...notice,
                  id: "notice-3",
                  subject: "new notice after acknowledgment",
                }
              : notice,
          ],
          ...(acknowledged ? {} : { next_notice_after_id: "notice-1" }),
        });
      }
      if (path === self + "/notices/acknowledge") {
        assert.deepEqual(request.postDataJSON(), { notice_ids: ["notice-1"] });
        if (writes.filter((row) => row.path === path).length === 1)
          return reply(
            { code: "unavailable", message: "Acknowledgment unavailable" },
            503,
          );
        acknowledged = true;
        return reply({ acknowledged_count: 1 });
      }
      if (path === self + "/binding-1" && method === "DELETE") {
        if (!request.postDataJSON().allow_lockout)
          return reply(
            {
              code: "external_identity_last_method",
              message: "Last login method",
            },
            409,
          );
        live = false;
        return reply({ revoked_count: 1, current_revoked: true });
      }
      if (path === chooser) {
        assert.equal(url.searchParams.get("limit"), "50");
        return reply({
          providers: [
            {
              id: "provider-1",
              name: provider.name,
              display_name: provider.display_name,
              enabled: provider.enabled,
              link_policy: provider.link_policy,
              link_domains: provider.link_domains,
              authoritative: provider.authoritative,
              link_policy_review_required: provider.link_policy_review_required,
            },
          ],
        });
      }
      if (path === organization) {
        if (method === "GET")
          return reply({
            bindings: restored
              ? [
                  {
                    ...binding,
                    membership_id: "target-member",
                    method: "admin",
                  },
                ]
              : [],
          });
        assert.deepEqual(request.postDataJSON(), {
          provider_id: "provider-1",
          subject: opaqueSubject,
          restore_revoked: writes.filter((row) => row.path === path).length > 1,
        });
        if (!request.postDataJSON().restore_revoked)
          return reply(
            {
              code: "external_identity_restore_required",
              message: "Explicit restoration required",
            },
            409,
          );
        restored = true;
        return reply({
          binding: {
            ...binding,
            membership_id: "target-member",
            method: "admin",
          },
        });
      }
      if (path === configuration) {
        assert(
          systemAdministrator,
          "organization controls must use the limited chooser",
        );
        if (method === "GET") return reply({ providers: [provider] });
        const body = request.postDataJSON();
        provider = {
          ...provider,
          link_policy: body.link_policy,
          link_domains: body.link_domains.map((domain) =>
            domain.trim().toLowerCase(),
          ),
          authoritative: body.authoritative,
          link_policy_review_required: !body.acknowledge_link_policy_review,
        };
        return reply({ provider });
      }
      if (path === tokenPath) {
        if (method === "GET") return reply({ tokens });
        const body = request.postDataJSON();
        assert.deepEqual(body, {
          name: "Paired directory",
          scopes: ["scim:read", "scim:write"],
          oidc_provider_id: "provider-1",
        });
        const token = { id: "token-2", ...body, created_at: timestamp };
        tokens = [...tokens, token];
        return reply({ token, credential: "one-time-synthetic-credential" });
      }
      unexpected.push(`${method} ${path}`);
      return reply({ code: "unexpected_route" }, 503);
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      errors.push("Unexpected script dialog");
      await dialog.dismiss();
    });
    await page.goto(`${origin}/#directory`);
    await page
      .getByRole("button", { name: "Review external login notices" })
      .click();
    let dialog = page.getByRole("dialog", { name: "Your external logins" });
    await dialog
      .getByText("Historical organization", { exact: true })
      .waitFor();
    assert.equal(
      await dialog.locator("code").first().textContent(),
      opaqueSubject,
    );
    assert.equal(await dialog.locator("img").count(), 0);
    await dialog.getByRole("button", { name: "Load more bindings" }).click();
    await dialog.getByText("Research", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Load more notices" }).click();
    await dialog.getByText("second notice", { exact: true }).waitFor();
    assert.equal(
      await dialog
        .getByRole("list", { name: "External login bindings" })
        .locator("li")
        .count(),
      2,
    );
    await dialog
      .getByRole("button", { name: "Acknowledge notice notice-1", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .getByText("Acknowledgment unavailable")
      .waitFor();
    await page.waitForTimeout(1200);
    assert.equal(
      writes.length,
      1,
      "acknowledgment must not automatically replay",
    );
    assert.equal(
      await dialog.getByText("historical subject", { exact: true }).count(),
      1,
    );
    await dialog
      .getByRole("button", { name: "Acknowledge notice notice-1", exact: true })
      .click();
    await dialog
      .getByText("historical subject", { exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await dialog.getByText("second notice", { exact: true }).count(),
      1,
    );
    await dialog
      .getByRole("button", { name: "Refresh external logins" })
      .click();
    await dialog
      .getByText("new notice after acknowledgment", { exact: true })
      .waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-external-notices.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Manage Alex external logins" })
      .filter({ visible: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Alex external logins" });
    await dialog.getByLabel("Login provider").selectOption("provider-1");
    await dialog.getByLabel("Provider subject").fill(opaqueSubject);
    await dialog.getByRole("button", { name: "Bind external login" }).click();
    await dialog
      .getByRole("button", { name: "Restore revoked binding" })
      .waitFor();
    assert.equal(writes.filter((row) => row.path === organization).length, 1);
    await dialog
      .getByRole("button", { name: "Restore revoked binding" })
      .click();
    await dialog.getByText("External login bound.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Unbind Workforce" }).waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-external-restored.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    systemAdministrator = true;
    await page.goto(`${origin}/#provisioning`);
    await page.reload();
    const edit = () =>
      page
        .getByRole("button", {
          name: label === "mobile" ? "Edit" : "Edit Workforce",
          exact: true,
        })
        .filter({ visible: true });
    await edit().click();
    dialog = page.getByRole("dialog", { name: "Edit login provider" });
    assert.equal(
      await dialog
        .getByLabel("I have reviewed this linking policy", { exact: true })
        .isChecked(),
      false,
    );
    await dialog
      .getByLabel("Client secret", { exact: true })
      .fill("rotated-synthetic-secret");
    await dialog.getByRole("button", { name: "Save provider" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByText("Policy review required", { exact: true })
      .filter({ visible: true })
      .waitFor();
    assert.deepEqual(
      writes.filter((row) => row.path === configuration)[0].body
        .acknowledge_link_policy_review,
      false,
    );
    await edit().click();
    dialog = page.getByRole("dialog", { name: "Edit login provider" });
    await dialog
      .getByLabel("Automatic linking policy")
      .selectOption("verified_email_in_domains");
    await dialog.getByLabel("Allowed email domains").fill(" Example.COM ");
    await dialog
      .getByLabel("Trust provider for organization administrators", {
        exact: true,
      })
      .check();
    await dialog
      .getByLabel("I have reviewed this linking policy", { exact: true })
      .check();
    await dialog.getByRole("button", { name: "Save provider" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByText("example.com", { exact: true })
      .filter({ visible: true })
      .waitFor();
    assert.equal(
      await page.getByText("Policy review required", { exact: true }).count(),
      0,
    );
    assert.deepEqual(
      writes.filter((row) => row.path === configuration)[1].body.link_domains,
      [" Example.COM "],
    );
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-external-policy.png`),
      fullPage: true,
    });
    await page.getByRole("tab", { name: "Directory sync" }).click();
    await page.getByRole("button", { name: "Issue SCIM token" }).click();
    dialog = page.getByRole("dialog", { name: "Issue SCIM token" });
    assert.equal(await dialog.getByLabel("Login provider").inputValue(), "");
    await dialog.getByLabel("Login provider").selectOption("provider-1");
    await dialog.getByLabel("Credential name").fill("Paired directory");
    await dialog.getByRole("button", { name: "Issue credential" }).click();
    dialog = page.getByRole("dialog", { name: "SCIM credential issued" });
    await dialog.getByText("provider-1", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("combobox").count(), 0);
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-external-pairing.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Review external login notices" })
      .click();
    dialog = page.getByRole("dialog", { name: "Your external logins" });
    await dialog.getByRole("button", { name: "Unbind Workforce" }).click();
    await dialog.getByRole("button", { name: "Confirm unbind" }).click();
    await dialog
      .getByRole("button", { name: "Unbind and accept lockout" })
      .waitFor();
    const beforeUnbind = selfReads;
    await dialog
      .getByRole("button", { name: "Unbind and accept lockout" })
      .click();
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    assert.equal(
      selfReads,
      beforeUnbind,
      "committed current revocation must not refetch private inventory",
    );
    assert.deepEqual(
      writes.filter((row) => row.method === "DELETE").map((row) => row.body),
      [{ allow_lockout: false }, { allow_lockout: true }],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    return {
      viewport: label,
      notices_independent: true,
      acknowledgment_no_replay: true,
      exact_subject_and_restore: true,
      review_acknowledgment: true,
      immutable_scim_pairing: true,
      current_revocation: true,
      browser_errors: errors.length,
    };
  } finally {
    await context.close();
  }
}
