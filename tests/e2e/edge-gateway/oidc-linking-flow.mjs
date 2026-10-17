import assert from "node:assert/strict";
import { join } from "node:path";
import {
  browserClient,
  login,
  quietObservers,
  signedOut,
} from "./browser-sessions-flow.mjs";
import { fixtureSecret } from "../identity-closeout/oidc-provider.mjs";
import { assertNoStore } from "../identity-closeout/support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";
import { opaqueSubject } from "./oidc-linking-fixture.mjs";
import { assertAgentReady } from "../../support/verification/agent-state.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";

const selfPath = "/api/session/external-identities";
const providerPath = "/api/admin/provisioning/oidc-providers";
const providerName = "linking-acceptance";
const admin = {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
const local = {
  organization_slug: "stage3",
  email: "oidc-local@example.com",
  password: "linking-local-password",
};
const displayName = "Linking organization administrator";

async function action(
  page,
  button,
  path,
  { method = "POST", status = 200, readBody = true } = {},
) {
  const [result] = await Promise.all([
    page
      .waitForResponse(
        (value) =>
          new URL(value.url()).pathname === path &&
          value.request().method() === method,
      )
      .then(async (response) => {
        assert.equal(
          response.status(),
          status,
          `${method} ${path}: unexpected response`,
        );
        // Capture the admitted body while the response is delivered, before the
        // click finishes and a current-session unbind retires its document.
        const body = readBody ? await response.json() : undefined;
        assertNoStore(new Headers(response.headers()));
        assert.equal((await response.headerValues("set-cookie")).length, 0);
        return { body, sent: response.request().postDataJSON() };
      }),
    button.click(),
  ]);
  return result;
}

async function inventory(client, suffix = "?limit=50") {
  const response = await client.request(selfPath + suffix);
  assertNoStore(response.headers);
  assert.equal(response.headers.getSetCookie().length, 0);
  return response.body;
}

async function rejectedSession(client) {
  const response = await client.request("/api/session", { status: 401 });
  assertNoStore(response.headers);
  assert.equal(response.headers.getSetCookie().length, 0);
}

async function oidcLogin(
  context,
  config,
  provider,
  account,
  path = "/",
  allowed = true,
) {
  for (const page of context.pages()) await page.close();
  await context.addCookies([
    {
      name: "oidc_fixture_account",
      value: account,
      url: new URL(provider.issuer).origin,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${config.gateway}/`);
  await page.getByLabel("Organization", { exact: true }).fill("stage3");
  const grants = provider.stats().grants;
  const [callback] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/protocol/oidc/callback",
    ),
    page
      .getByRole("button", {
        name: `Continue with ${providerName}`,
        exact: true,
      })
      .click(),
  ]);
  assert.equal(callback.status(), 303);
  assert.equal(
    provider.stats().grants,
    grants + 1,
    "real signed token exchange must occur",
  );
  const destination = allowed ? "/" : "/?auth_error=oidc_login_failed";
  assert.equal(await callback.headerValue("location"), destination);
  await callback.finished();
  const client = await browserClient(context, config.gateway);
  if (!allowed) {
    // LoginPage removes auth_error from the URL after retaining this message.
    await page
      .getByText(
        "Single sign-on could not be completed. Please try again or use your local account.",
        { exact: true },
      )
      .waitFor();
    await rejectedSession(client);
    await signedOut(page);
    return { page, client };
  }
  const session = await client.request("/api/session");
  assertNoStore(session.headers);
  assert.equal(session.headers.getSetCookie().length, 0);
  for (const name of ["__Host-antnest_session", "__Host-antnest_csrf"]) {
    const cookie = (await context.cookies(config.gateway)).find(
      (row) => row.name === name,
    );
    assert(cookie?.secure);
    assert.equal(cookie.httpOnly, name.endsWith("_session"));
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.path, "/");
  }
  // The successful callback returns to the login page's original URL. A URL
  // wait alone can match that old document before the redirect commits. Wait
  // for the authenticated shell; ordinary members also finish Console's
  // automatic Workspace navigation before a test requests another page.
  await page
    .getByRole("button", {
      name: /^(Manage external logins|Account and sessions)$/u,
      includeHidden: true,
    })
    .first()
    .waitFor({ state: "attached" });
  if (new URL(page.url()).pathname !== path)
    await page.goto(`${config.gateway}${path}`);
  return { page, client, metadata: session.body };
}

async function organizationBinding(
  page,
  membership,
  providerID,
  subject,
  restore = false,
) {
  await page.goto(new URL("/#directory", page.url()).href);
  await page
    .getByRole("button", {
      name: `Manage ${membership.display_name} external logins`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `${membership.display_name} external logins`,
    exact: true,
  });
  await dialog
    .getByLabel("Login provider", { exact: true })
    .selectOption(providerID);
  await dialog.getByLabel("Provider subject", { exact: true }).fill(subject);
  const path = `/api/admin/directory/memberships/${membership.id}/external-identities`;
  const first = await action(
    page,
    dialog.getByRole("button", { name: "Bind external login", exact: true }),
    path,
    { status: restore ? 409 : 200 },
  );
  assert.deepEqual(first.sent, {
    provider_id: providerID,
    subject,
    restore_revoked: false,
  });
  let result = first;
  if (restore) {
    assert.equal(first.body.code, "external_identity_restore_required");
    result = await action(
      page,
      dialog.getByRole("button", {
        name: "Restore revoked binding",
        exact: true,
      }),
      path,
    );
    assert.deepEqual(result.sent, {
      provider_id: providerID,
      subject,
      restore_revoked: true,
    });
  }
  assert.equal(result.body.binding.subject, subject);
  assert.equal(result.body.binding.revoked_at, null);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  return result.body.binding;
}

async function externalDialog(page, workspace = false) {
  await page
    .getByRole("button", { name: "Review external login notices", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: workspace ? "Account and sessions" : "Your external logins",
    exact: true,
  });
  await dialog
    .getByRole("list", { name: "External login bindings", exact: true })
    .waitFor();
  return dialog;
}

async function unbind(page, dialog, binding, lockout = false) {
  await dialog
    .getByRole("button", {
      name: `Unbind ${binding.provider_display_name}`,
      exact: true,
    })
    .click();
  const path = `${selfPath}/${encodeURIComponent(binding.id)}`;
  const first = await action(
    page,
    dialog.getByRole("button", { name: "Confirm unbind", exact: true }),
    path,
    { method: "DELETE", status: lockout ? 409 : 200, readBody: lockout },
  );
  assert.deepEqual(first.sent, { allow_lockout: false });
  let result = first;
  if (lockout) {
    assert.equal(first.body.code, "external_identity_last_method");
    // The next request is caused only by this separate, explicit UI action.
    result = await action(
      page,
      dialog.getByRole("button", {
        name: "Unbind and accept lockout",
        exact: true,
      }),
      path,
      { method: "DELETE", readBody: false },
    );
    assert.deepEqual(result.sent, { allow_lockout: true });
  }
  // Successful current-session removal navigates immediately. CDP body
  // retrieval is not reliable across that navigation; the caller checks the
  // committed 200/no-cookie response, both old sessions and private UI removal.
  return { committed: true };
}

export async function verifyOIDCLinking({
  browser,
  config,
  fixture,
  provider,
  signal,
  output,
  record = () => {},
}) {
  signal.throwIfAborted();
  const contexts = [],
    protocol = [],
    phases = [],
    tasks = new Set(),
    wireErrors = [];
  let ordinaryResponses = 0,
    modelHeld = false;
  const heldPhase = "c4-browser-hold-logout";
  const phase = (name, details = {}) => {
    phases.push({ name, ...details });
    record({ phases, callbacks: provider.stats().grants });
    console.log(JSON.stringify({ phase: "oidc-linking", verified: name }));
  };
  const context = async (mobile = false) => {
    signal.throwIfAborted();
    const value = await browser.newContext({
      // Apply only to this disposable context. A machine proxy can otherwise
      // resolve host.docker.internal remotely despite Chromium's DNS mapping.
      proxy: {
        server: "http://127.0.0.1:9",
        bypass: "127.0.0.1,host.docker.internal",
      },
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
    });
    contexts.push(value);
    signal.throwIfAborted();
    const publicPath = (raw) => {
      const url = new URL(raw);
      return url.origin + url.pathname;
    };
    value.on("requestfailed", (request) =>
      protocol.push({
        path: publicPath(request.url()),
        failure: request.failure()?.errorText,
      }),
    );
    value.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (
        path === "/api/session/oidc/start" ||
        path === "/protocol/oidc/callback" ||
        new URL(response.url()).hostname === "host.docker.internal"
      )
        protocol.push({
          path: publicPath(response.url()),
          status: response.status(),
        });
      if (!path.startsWith(selfPath)) return;
      const task = (async () => {
        assertNoStore(new Headers(response.headers()));
        assert.equal((await response.headerValues("set-cookie")).length, 0);
        ordinaryResponses++;
      })().catch(() =>
        wireErrors.push(`${response.request().method()} ${path}`),
      );
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
    return value;
  };
  const model = async (path = "/status", method = "GET", cleanup = false) => {
    const response = await fetch(config.model + path, {
      method,
      signal: cleanup
        ? AbortSignal.timeout(5000)
        : AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    if (result.errors) assert.deepEqual(result.errors, []);
    return result;
  };
  let observers;
  try {
    const system = await login(await context(), config.gateway, admin, "/");
    await system.page
      .getByRole("button", { name: "Add local user", exact: true })
      .click();
    const create = system.page.getByRole("dialog", {
      name: "Add local user",
      exact: true,
    });
    await create.getByLabel("Display name", { exact: true }).fill(displayName);
    await create.getByLabel("Email", { exact: true }).fill(local.email);
    await create
      .getByLabel("Initial password", { exact: true })
      .fill(local.password);
    await create
      .getByLabel("Organization role", { exact: true })
      .selectOption("admin");
    const created = (
      await action(
        system.page,
        create.getByRole("button", { name: "Create user", exact: true }),
        "/api/admin/directory/users",
      )
    ).body;
    assert.equal(created.user.system_role, "user");
    assert.equal(created.membership.role, "admin");
    await create.waitFor({ state: "hidden" });
    await system.page.goto(`${config.gateway}/#provisioning`);
    await system.page
      .getByRole("button", { name: "Add login provider", exact: true })
      .click();
    const addProvider = system.page.getByRole("dialog", {
      name: "Add login provider",
      exact: true,
    });
    await addProvider
      .getByLabel("Provider key", { exact: true })
      .fill(providerName);
    await addProvider
      .getByLabel("Issuer URL", { exact: true })
      .fill(provider.issuer);
    await addProvider
      .getByLabel("Client ID", { exact: true })
      .fill("gateway-oidc-test");
    await addProvider
      .getByLabel("Client secret", { exact: true })
      .fill(fixtureSecret(1));
    assert.equal(
      await addProvider
        .getByLabel("Automatic linking policy", { exact: true })
        .inputValue(),
      "none",
    );
    const registered = (
      await action(
        system.page,
        addProvider.getByRole("button", { name: "Add provider", exact: true }),
        providerPath,
      )
    ).body.provider;
    assert.equal(registered.link_policy, "none");
    assert.deepEqual(registered.link_domains, []);
    assert.equal(registered.authoritative, false);
    assert.equal(registered.link_policy_review_required, false);
    assert.equal(registered.display_name, providerName);
    assert(!JSON.stringify(registered).includes(fixtureSecret(1)));
    await addProvider.waitFor({ state: "hidden" });
    const choices = await fixture.json(
      "/api/admin/directory/identity-providers?limit=50",
    );
    const providerID = choices.providers.find(
      (row) => row.name === providerName,
    )?.id;
    assert(providerID);
    const consoleContext = await context(),
      workspaceContext = await context(true);
    await oidcLogin(consoleContext, config, provider, "local", "/", false);
    const empty = await fixture.json(
      `/api/admin/directory/memberships/${created.membership.id}/external-identities?limit=50`,
    );
    assert.deepEqual(empty.bindings, []);
    phase("default-none-denies-asserted-organization-administrator-email", {
      realSignedCallback: true,
      systemAdministrator: false,
    });

    const bound = await organizationBinding(
      system.page,
      created.membership,
      providerID,
      "local-subject",
    );
    let consoleSession = await oidcLogin(
      consoleContext,
      config,
      provider,
      "local",
    );
    let workspaceSession = await oidcLogin(
      workspaceContext,
      config,
      provider,
      "local",
      "/workspace/",
    );
    assert.equal(consoleSession.metadata.principal.user_id, created.user.id);
    assert.equal(
      workspaceSession.metadata.principal.membership_id,
      created.membership.id,
    );
    await workspaceSession.page
      .getByText("No Agent available", { exact: true })
      .waitFor();
    let consoleDialog = await externalDialog(consoleSession.page);
    let workspaceDialog = await externalDialog(workspaceSession.page, true);
    const firstNotice = (await inventory(consoleSession.client)).notices;
    assert.equal(firstNotice.length, 1);
    assert.equal(firstNotice[0].binding_id, bound.id);
    assert.deepEqual(
      (await inventory(workspaceSession.client)).notices,
      firstNotice,
    );
    const acknowledged = await action(
      consoleSession.page,
      consoleDialog.getByRole("button", {
        name: `Acknowledge notice ${firstNotice[0].id}`,
        exact: true,
      }),
      `${selfPath}/notices/acknowledge`,
    );
    assert.deepEqual(acknowledged.sent, { notice_ids: [firstNotice[0].id] });
    assert.equal(acknowledged.body.acknowledged_count, 1);
    const repeated = await action(
      workspaceSession.page,
      workspaceDialog.getByRole("button", {
        name: `Acknowledge ${bound.provider_display_name} in ${bound.organization_name}`,
        exact: true,
      }),
      `${selfPath}/notices/acknowledge`,
    );
    assert.deepEqual(repeated.sent, acknowledged.sent);
    assert.equal(repeated.body.acknowledged_count, 0);
    await workspaceSession.page.screenshot({
      path: join(output, "linking-mobile-no-agent.png"),
      fullPage: true,
    });
    const removed = await unbind(workspaceSession.page, workspaceDialog, bound);
    await signedOut(workspaceSession.page);
    await rejectedSession(workspaceSession.client);
    await rejectedSession(consoleSession.client);
    // A Console directory has no passive event stream. A real refresh receives
    // the peer 401 and must then remove its private document.
    await consoleDialog
      .getByRole("button", { name: "Refresh external logins", exact: true })
      .click();
    await signedOut(consoleSession.page);
    phase("prebind-notices-exact-ack-and-current-unbind", {
      committed: removed.committed,
      twoBrowserSessionsDenied: true,
      peerConsoleRetiredAfter401: true,
    });
    // Enable a policy that would match this administrator's verified email.
    // The next denial must be caused by the tombstone, not by default-none.
    await system.page.goto(`${config.gateway}/#provisioning`);
    await system.page
      .getByRole("button", { name: `Edit ${providerName}`, exact: true })
      .click();
    const editProvider = system.page.getByRole("dialog", {
      name: "Edit login provider",
      exact: true,
    });
    await editProvider
      .getByLabel("Automatic linking policy", { exact: true })
      .selectOption("verified_email");
    await editProvider
      .getByLabel("Trust provider for organization administrators", {
        exact: true,
      })
      .check();
    const trusting = (
      await action(
        system.page,
        editProvider.getByRole("button", {
          name: "Save provider",
          exact: true,
        }),
        providerPath,
      )
    ).body.provider;
    assert.equal(trusting.link_policy, "verified_email");
    assert.deepEqual(trusting.link_domains, []);
    assert.equal(trusting.authoritative, true);
    assert.equal(trusting.enabled, true);
    await editProvider.waitFor({ state: "hidden" });
    await oidcLogin(consoleContext, config, provider, "local", "/", false);
    const tombstones = await fixture.json(
      `/api/admin/directory/memberships/${created.membership.id}/external-identities?limit=50`,
    );
    assert.equal(tombstones.bindings[0].id, bound.id);
    assert(tombstones.bindings[0].revoked_at);
    const restored = await organizationBinding(
      system.page,
      created.membership,
      providerID,
      "local-subject",
      true,
    );
    assert.equal(restored.id, bound.id);
    consoleSession = await oidcLogin(consoleContext, config, provider, "local");
    const restoredInventory = await inventory(consoleSession.client);
    assert.equal(restoredInventory.notices.length, 1);
    assert.notEqual(restoredInventory.notices[0].id, firstNotice[0].id);
    const oldAck = await consoleSession.client.request(
      `${selfPath}/notices/acknowledge`,
      { body: { notice_ids: [firstNotice[0].id] } },
    );
    assert.equal(oldAck.body.acknowledged_count, 0);
    assert.deepEqual(
      (await inventory(consoleSession.client)).notices,
      restoredInventory.notices,
    );
    consoleDialog = await externalDialog(consoleSession.page);
    await consoleDialog
      .getByRole("button", {
        name: `Acknowledge notice ${restoredInventory.notices[0].id}`,
        exact: true,
      })
      .waitFor();
    await consoleSession.page.screenshot({
      path: join(output, "linking-console-restoration.png"),
      fullPage: true,
    });
    phase("tombstone-denies-callback-and-explicit-restore-creates-new-notice", {
      automaticAdministratorLinkingEnabled: true,
      oldAcknowledgmentPreservesNewNotice: true,
    });

    // Pair through the actual limited chooser; the credential never enters evidence.
    await system.page.goto(`${config.gateway}/#provisioning`);
    await system.page
      .getByRole("tab", { name: "Directory sync", exact: true })
      .click();
    await system.page
      .getByRole("button", { name: "Issue SCIM token", exact: true })
      .click();
    const tokenDialog = system.page.getByRole("dialog", {
      name: "Issue SCIM token",
      exact: true,
    });
    await tokenDialog
      .getByLabel("Credential name", { exact: true })
      .fill("Linking paired directory");
    await tokenDialog
      .getByLabel("Login provider", { exact: true })
      .selectOption(providerID);
    await tokenDialog.getByLabel("Read directory", { exact: true }).check();
    await tokenDialog
      .getByLabel("Provision directory", { exact: true })
      .check();
    const issued = (
      await action(
        system.page,
        tokenDialog.getByRole("button", {
          name: "Issue credential",
          exact: true,
        }),
        "/api/admin/provisioning/scim-tokens",
      )
    ).body;
    assert.equal(issued.token.oidc_provider_id, providerID);
    await system.page
      .getByRole("dialog", { name: "SCIM credential issued", exact: true })
      .getByRole("button", { name: "Done", exact: true })
      .click();
    const scimRequest = async (path, body, method = "POST", status = 201) => {
      const response = await fetch(`${config.gateway}/scim/v2${path}`, {
        method,
        headers: {
          authorization: `Bearer ${issued.credential}`,
          "content-type": "application/scim+json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.getSetCookie().length, 0);
      return response.json();
    };
    const scimBody = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "linked-scim@example.com",
      displayName: "Linked SCIM user",
      active: true,
      externalId: opaqueSubject,
    };
    const scimUser = await scimRequest("/Users", scimBody);
    assert.equal(scimUser.externalId, opaqueSubject);
    const scimConsole = await context(),
      scimWorkspace = await context(true);
    const scimPeer = await oidcLogin(
      scimConsole,
      config,
      provider,
      "opaque",
      "/workspace/",
    );
    const scimSession = await oidcLogin(
      scimWorkspace,
      config,
      provider,
      "opaque",
      "/workspace/",
    );
    await scimSession.page
      .getByText("No Agent available", { exact: true })
      .waitFor();
    const account = (await scimSession.client.request("/api/session/account"))
      .body.account;
    assert.equal(account.source, "scim");
    assert.equal(account.local_password_available, false);
    const scimInventory = await inventory(scimSession.client);
    assert.equal(scimInventory.bindings.length, 1);
    const scimBinding = scimInventory.bindings[0];
    assert.equal(scimBinding.subject, opaqueSubject);
    assert.equal(scimBinding.method, "scim");
    const scimPanel = await externalDialog(scimSession.page, true);
    assert.equal(
      await scimPanel.locator("code").first().textContent(),
      opaqueSubject,
    );
    assert.equal(await scimPanel.locator("code b").count(), 0);
    assert.equal(
      await scimPanel
        .getByRole("heading", { name: "Change password", exact: true })
        .count(),
      0,
    );
    await scimSession.page.screenshot({
      path: join(output, "linking-scim-opaque-subject.png"),
      fullPage: true,
    });
    await unbind(scimSession.page, scimPanel, scimBinding, true);
    await signedOut(scimSession.page);
    await rejectedSession(scimSession.client);
    await rejectedSession(scimPeer.client);
    await oidcLogin(
      scimWorkspace,
      config,
      provider,
      "opaque",
      "/workspace/",
      false,
    );
    const retried = await scimRequest(
      `/Users/${encodeURIComponent(scimUser.id)}`,
      scimBody,
      "PUT",
      200,
    );
    assert.equal(retried.externalId, opaqueSubject);
    await oidcLogin(
      scimWorkspace,
      config,
      provider,
      "opaque",
      "/workspace/",
      false,
    );
    phase(
      "paired-scim-opaque-no-email-login-and-explicit-last-method-lockout",
      { noPassword: true, noAgent: true, retryCannotRestore: true },
    );

    const directory = await fixture.json("/api/admin/directory");
    const owner = directory.users.find(
      (row) => row.user.id === fixture.ownerID,
    )?.membership;
    assert(owner);
    await fixture.json(`/api/admin/directory/memberships/${owner.id}`, {
      body: {
        email: owner.email,
        display_name: owner.display_name,
        role: "admin",
        active: true,
      },
    });
    const ownerBinding = await organizationBinding(
      system.page,
      owner,
      providerID,
      "workspace-subject",
    );
    const ownerConsole = await oidcLogin(
      await context(),
      config,
      provider,
      "workspace",
    );
    const ownerWorkspace = await oidcLogin(
      await context(),
      config,
      provider,
      "workspace",
      `/workspace/${fixture.agentID}/`,
    );
    const ready = await fixture.ready();
    const input = ownerWorkspace.page.getByRole("combobox", {
      name: "Message",
      exact: true,
    });
    await until(() => input.isEnabled(), "OIDC owner composer ready", signal);
    await input.fill(heldPhase);
    modelHeld = true;
    await ownerWorkspace.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await until(
      async () => (await model()).pending.includes(heldPhase),
      "accepted Run held at model",
      signal,
    );
    const audits = await fixture.json(
      `/api/admin/execution-audits?agent_id=${fixture.agentID}&limit=100`,
    );
    assert.equal(audits.next_cursor, null);
    const runs = [];
    for (const item of audits.items)
      runs.push(
        await fixture.json(`/api/admin/execution-audits/${item.run_id}`),
      );
    const matching = runs.filter((run) => run.input[0]?.text === heldPhase);
    assert.equal(matching.length, 1);
    const run = matching[0];
    assert(!["completed", "failed", "unresolved"].includes(run.state));
    const ownerDialog = await externalDialog(ownerConsole.page);
    observers = await quietObservers(
      config,
      fixture.agentID,
      ownerWorkspace.client,
      signal,
      ownerWorkspace.metadata,
    );
    const at = observers.beforeMutation();
    const ownerRemoved = await unbind(
      ownerConsole.page,
      ownerDialog,
      ownerBinding,
    );
    await signedOut(ownerConsole.page);
    const streams = await observers.revoked(at);
    await signedOut(ownerWorkspace.page);
    await rejectedSession(ownerConsole.client);
    await rejectedSession(ownerWorkspace.client);
    const held = await model();
    assert(
      held.pending.includes(heldPhase),
      "session revocation must not cancel accepted work",
    );
    assert.equal(
      held.requests.filter((row) => row.phase === heldPhase).length,
      1,
    );
    assert.equal(
      held.requests.find((row) => row.phase === heldPhase).disconnected,
      undefined,
    );
    await model(`/release/${heldPhase}`, "POST");
    modelHeld = false;
    const terminal = await until(
      async () => {
        const value = await fixture.json(
          `/api/admin/execution-audits/${run.run_id}`,
        );
        return value.state === "completed" && value;
      },
      "same accepted Run completes after unbind",
      signal,
    );
    assert.equal(terminal.run_id, run.run_id);
    assert.equal(terminal.terminal_class, "completed");
    assert.equal(terminal.executor_state, "quiescent");
    const after = await fixture.ready();
    assertAgentReady(after);
    assert.equal(
      after.runtime.runtime_revision,
      ready.runtime.runtime_revision,
    );
    assert.equal(
      after.runtime.runtime_execution_id,
      ready.runtime.runtime_execution_id,
    );
    assert.equal(
      after.executable_execution_revision,
      ready.executable_execution_revision,
    );
    assert.equal(
      (await model()).requests.filter((row) => row.phase === heldPhase).length,
      1,
    );
    await observers.close();
    observers = undefined;
    phase(
      "unbind-retires-both-browsers-and-quiet-streams-without-offboarding",
      {
        committed: ownerRemoved.committed,
        streams,
        sameRunCompleted: true,
        sameRuntime: true,
        modelRequests: 1,
      },
    );
    await Promise.all([...tasks]);
    assert.deepEqual(wireErrors, []);
    assert(ordinaryResponses > 0);
    return {
      phases,
      callbacks: provider.stats().grants,
      externalIdentityResponses: ordinaryResponses,
      ordinaryCookieWriters: 0,
      apiInterceptions: 0,
    };
  } catch (error) {
    writeEvidenceFile(
      output,
      "linking-failure.private.json",
      JSON.stringify(
        {
          phases,
          protocol,
          provider: provider.stats(),
          pages: contexts.flatMap((value) =>
            value.pages().map((page) => {
              const url = new URL(page.url());
              return { origin: url.origin, path: url.pathname };
            }),
          ),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    try {
      if (
        modelHeld &&
        (await model("/status", "GET", true)).pending.includes(heldPhase)
      )
        await model(`/release/${heldPhase}`, "POST", true);
    } finally {
      try {
        await observers?.close();
      } finally {
        for (const value of contexts) await value.close();
      }
    }
  }
}
