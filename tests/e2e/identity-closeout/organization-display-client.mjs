import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient, assertNoStore } from "./support.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { assertOrganizationSession } from "./organization-session.mjs";
import {
  assertWorkspaceBootstrap,
  assertWorkspaceDocument,
} from "./organization-workspace.mjs";
import { createFixtureClient, parseFixtureJSON } from "./oidc-transport.mjs";
import { fixtureSecret, providerAccessToken } from "./oidc-provider.mjs";
import { createAccessCatalog } from "./catalog.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { workspacePath } from "../../../services/agent-ui/web/server/src/protocol/workspace-route.ts";

const [gateway, port, certPath, seedPath, canaryPath] = process.argv.slice(2);
assert(
  gateway && port && certPath && seedPath && canaryPath,
  "Organization integration arguments required",
);
assert.equal(process.env.ANTNEST_E2E_DISPOSABLE, "true");
const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? "", /^antnest-stage3-e2e-[0-9]+$/u);
const seed = JSON.parse(await readFile(seedPath, "utf8"));
const canaries = {
  canaries: ["stage3-admin-password", fixtureSecret(1), providerAccessToken],
  traceIDs: [],
};
const memberEmail = "oidc-local@example.com";
const password = "synthetic-oidc-local-password";
const secrets = [
  ...canaries.canaries,
  password,
  "synthetic-organization-model-a",
  "synthetic-organization-model-b",
];
const requireUI = createRequire(
  new URL("../../../services/agent-ui/web/package.json", import.meta.url),
);
const { chromium } = requireUI("playwright");
const issuer = "https://oidc-fixture:8443";
const idp = createFixtureClient({ issuer, port, ca: await readFile(certPath) });
const docker = dockerClient(process.env, undefined, 480000);
const contexts = [];
const checks = [];
const browserProblems = [];
const browserRequests = [];
let browser,
  original,
  renamed = false,
  step = "ownership",
  bootstraps = 0,
  documents = 0,
  oidcRedirects = 0;
const admin = new GatewayClient(gateway);
const member = new GatewayClient(gateway);
const other = new GatewayClient(gateway);
const remember = (client) => secrets.push(...client.cookies.values());
const agentPath = (agentId) => workspacePath({ agentId, sessionId: null });
const stablePrincipal = (value) => {
  const result = { ...value };
  delete result.organization_slug;
  delete result.organization_name;
  return result;
};
const literal = (value) => "'" + value.replace(/'/g, "''") + "'";

async function verifyOwnership() {
  for (const service of ["postgres", "identity-service"]) {
    const row = JSON.parse(
      await docker(["inspect", `${project}-${service}-1`]),
    )[0];
    assert.equal(
      row.Config.Labels["com.docker.compose.project"],
      project,
      "Disposable fixture ownership changed",
    );
    assert.equal(row.Config.Labels["com.docker.compose.service"], service);
    assert.equal(row.State.Running, true);
    if (service === "identity-service")
      assert.equal(
        row.Config.Labels["io.antnest.e2e-run-id"],
        process.env.ANTNEST_E2E_RUN_ID,
      );
  }
}
async function organizationRow(id, replacement) {
  await verifyOwnership();
  // Identity has no public display-rename command. This bounded fixture changes
  // only display columns in its owned disposable database, never auth facts.
  const statement = replacement
    ? `UPDATE organizations SET slug=${literal(replacement.slug)}, name=${literal(replacement.name)} WHERE id=${literal(id)} RETURNING json_build_object('id',id,'slug',slug,'name',name)`
    : `SELECT json_build_object('id',id,'slug',slug,'name',name) FROM organizations WHERE id=${literal(id)}`;
  const output = await docker([
    "exec",
    `${project}-postgres-1`,
    "psql",
    "-X",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "antnest_test_admin",
    "-d",
    "antnest_identity",
    "-c",
    statement,
  ]);
  const rows = output.split("\n").filter((line) => line.startsWith("{"));
  assert.equal(
    rows.length,
    1,
    "Identity Organization row missing or ambiguous",
  );
  const row = JSON.parse(rows[0]);
  assert.equal(row.id, id);
  return row;
}
async function login(client, slug, email = memberEmail, credential = password) {
  const response = await client.request("/api/session/login", {
    body: { organization_slug: slug, email, password: credential },
  });
  remember(client);
  assertSecretFree(JSON.stringify(response.body), secrets);
  return assertOrganizationSession(response.body, "login", {
    slug,
    name: slug === "stage3" ? "Stage 3" : seed.organization.name,
  });
}
async function createAgent(client, principal, key) {
  const { template } = await createAccessCatalog(client, {
    name: `Organization display ${key}`,
    modelName: `display-${key}`,
    credential: `synthetic-organization-model-${key}`,
    baseURL: "http://unused-model-fixture:8080/v1",
    runtimeImage: process.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    systemPrompt: "Organization display fixture; no model request is submitted",
    maxModelRequests: 1,
  });
  const created = (
    await client.request("/api/admin/agents", {
      status: 202,
      body: {
        owner_user_id: principal.user_id,
        name: `Display Agent ${key}`,
        template_id: template.template_id,
        template_revision: template.revision,
      },
    })
  ).body;
  const deadline = Date.now() + 120000;
  let completed = false;
  while (Date.now() < deadline) {
    const operation = (
      await client.request(
        `/api/admin/operations/${created.operation.request_id}`,
      )
    ).body;
    assert.notEqual(
      operation.state,
      "failed",
      "Display fixture Agent creation failed",
    );
    if (operation.state === "completed") {
      completed = true;
      break;
    }
    await delay(250);
  }
  assert(completed, "Display fixture Agent creation timed out");
  const id = created.agent.agent_id;
  await waitForAgentReady(
    async () => (await client.request(`/api/admin/agents/${id}`)).body,
  );
  return id;
}
async function bootstrap(client, principal, row, ids, headers = {}) {
  const response = await client.request("/api/app/workspace/v1/bootstrap", {
    headers,
  });
  assertNoStore(response.headers);
  assertWorkspaceBootstrap(response.body, principal, row, ids, secrets);
  bootstraps++;
  return response.body;
}
async function browserJSON(context, path, status = 200) {
  const response = await context.request.get(gateway + path, {
    timeout: 15000,
  });
  assert.equal(
    response.status(),
    status,
    `${path.split("?")[0]}: browser HTTP status`,
  );
  const body = await response.json();
  assertSecretFree(JSON.stringify(body), secrets);
  return body;
}
async function localBrowserLogin(context, slug, row) {
  const page = await context.newPage();
  watchBrowser(page);
  await page.goto(gateway, { waitUntil: "domcontentloaded" });
  await page.locator('[name="organization_slug"]').fill(slug);
  await page.locator('[name="email"]').fill(memberEmail);
  await page.locator('[name="password"]').fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === "/api/session/login" &&
        value.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  // The member UI immediately navigates, which can discard CDP's completed
  // response body. The browser's cookie-backed session is a stable wire oracle.
  const session = assertOrganizationSession(
    await browserJSON(context, "/api/session"),
    "session",
    row,
  );
  if (session.organization_role !== "admin" && session.system_role !== "admin")
    await page.waitForURL(
      (url) => url.origin === gateway && url.pathname.startsWith("/workspace/"),
      { waitUntil: "domcontentloaded" },
    );
  return page;
}
function watchBrowser(page) {
  page.on("pageerror", () => browserProblems.push("page-error"));
  page.on("console", (message) => {
    if (/hydration|did not match|server rendered HTML/i.test(message.text()))
      browserProblems.push("hydration-error");
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === gateway || url.origin === issuer) {
      browserRequests.push({
        peer: url.origin === gateway ? "gateway" : "idp",
        path: url.pathname,
        status: response.status(),
      });
      if (browserRequests.length > 40) browserRequests.shift();
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    browserRequests.push({
      peer: url.origin === gateway ? "gateway" : "idp",
      path: url.pathname,
      failure:
        request.failure()?.errorText.match(/ERR_[A-Z0-9_]+/u)?.[0] ??
        "request-failed",
    });
    if (browserRequests.length > 40) browserRequests.shift();
  });
}
async function rememberBrowser(context) {
  secrets.push(...(await context.cookies()).map((cookie) => cookie.value));
}
async function view(page, principal, row, agentID) {
  const directory = await page.goto(gateway + "/workspace/", {
    waitUntil: "domcontentloaded",
  });
  assert.equal(directory?.status(), 200);
  assertWorkspaceDocument(
    await directory.text(),
    principal,
    row,
    [agentID],
    secrets,
  );
  documents++;
  await page.locator(".chooser-kicker").filter({ hasText: row.name }).waitFor();
  assert.equal(await page.locator(".chooser-kicker").innerText(), row.name);
  assert.equal(
    await page
      .getByRole("link", { name: "Open Control Center", exact: true })
      .count(),
    principal.organization_role === "admin" ? 1 : 0,
  );
  assertWorkspaceBootstrap(
    await browserJSON(page.context(), "/api/app/workspace/v1/bootstrap"),
    principal,
    row,
    [agentID],
    secrets,
  );
  bootstraps++;
  const document = await page.goto(gateway + agentPath(agentID), {
    waitUntil: "domcontentloaded",
  });
  assert.equal(document?.status(), 200);
  assertWorkspaceDocument(
    await document.text(),
    principal,
    row,
    [agentID],
    secrets,
  );
  documents++;
  await page
    .locator(".profile-copy small")
    .filter({ hasText: row.name })
    .waitFor();
  assert.equal(await page.locator(".profile-copy small").innerText(), row.name);
  assertSecretFree(await page.content(), secrets);
}
async function ssr(context, principal, row, agentID) {
  const readOnly = await browser.newContext({ javaScriptEnabled: false });
  contexts.push(readOnly);
  await readOnly.addCookies(await context.cookies());
  const page = await readOnly.newPage();
  for (const [path, selector] of [
    ["/workspace/", ".chooser-kicker"],
    [agentPath(agentID), ".profile-copy small"],
  ]) {
    const response = await page.goto(gateway + path, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response?.status(), 200);
    assertWorkspaceDocument(
      await response.text(),
      principal,
      row,
      [agentID],
      secrets,
    );
    documents++;
    assert.equal(await page.locator(selector).innerText(), row.name);
  }
  await readOnly.close();
  contexts.splice(contexts.indexOf(readOnly), 1);
}

try {
  await verifyOwnership();
  step = "setup";
  const administrator = await login(
    admin,
    "stage3",
    "stage3-admin@example.com",
    "stage3-admin-password",
  );
  const a = await login(member, "stage3");
  const b = await login(other, seed.organization.slug);
  assert.equal(a.user_id, b.user_id);
  assert.equal(a.user_id, seed.shared_user_id);
  assert.notEqual(a.organization_id, b.organization_id);
  assert.equal(a.system_role, "user");
  assert.equal(a.organization_role, "member");
  assert.equal(b.system_role, "user");
  assert.equal(b.organization_role, "admin");
  assert.equal(administrator.system_role, "admin");
  original = await organizationRow(a.organization_id);
  const foreign = await organizationRow(b.organization_id);
  const agentA = await createAgent(admin, a, "a");
  const agentB = await createAgent(other, b, "b");
  checks.push("same-user-member-and-organization-administrator-fixtures");

  step = "isolation";
  for (const [client, principal, row, own, denied] of [
    [member, a, original, agentA, agentB],
    [other, b, foreign, agentB, agentA],
  ]) {
    const headers = {
      "X-Antnest-Organization-ID":
        principal.organization_id === a.organization_id
          ? b.organization_id
          : a.organization_id,
      "X-Antnest-Organization-Name": Buffer.from(
        "Forged Organization",
      ).toString("base64url"),
      "X-Antnest-Organization-Slug":
        Buffer.from("forged").toString("base64url"),
      "X-Antnest-Administrator": "true",
    };
    await bootstrap(client, principal, row, [own], headers);
    const response = await client.request(
      `/api/app/workspace/v1/agents/${denied}/view?organization_id=${headers["X-Antnest-Organization-ID"]}`,
      { headers, status: 403 },
    );
    assert.equal(response.body.code, "access_denied");
    assertSecretFree(JSON.stringify(response.body), secrets);
    assert(
      !JSON.stringify(response.body).includes(denied),
      "Denied response redisclosed a foreign resource",
    );
  }
  await member.request("/api/admin/provisioning/oidc-providers", {
    status: 403,
  });
  const providerName = `organization-display-${randomUUID()}`;
  const registered = await admin.request(
    "/api/admin/provisioning/oidc-providers",
    {
      body: {
        name: providerName,
        issuer,
        client_id: "gateway-oidc-test",
        client_secret: fixtureSecret(1),
        scopes: ["openid", "email", "profile"],
        enabled: true,
      },
    },
  );
  assertSecretFree(JSON.stringify(registered.body), secrets);
  assert(registered.traceID, "OIDC registration trace identity missing");
  canaries.traceIDs.push(registered.traceID);
  const methods = (
    await admin.request("/api/session/login-methods", {
      body: { organization_slug: original.slug },
    })
  ).body.methods;
  const method = methods.find((value) => value.name === providerName);
  assert(method, "Enabled OIDC login method missing");
  checks.push("forged-headers-and-foreign-agents-denied-with-id-based-scope");

  step = "browser-local-member";
  browser = await chromium.launch({ headless: true });
  const localContext = await browser.newContext();
  contexts.push(localContext);
  localContext.setDefaultTimeout(30000);
  const localPage = await localBrowserLogin(
    localContext,
    original.slug,
    original,
  );
  await rememberBrowser(localContext);
  await view(localPage, a, original, agentA);
  await ssr(localContext, a, original, agentA);
  step = "browser-local-administrator";
  const adminContext = await browser.newContext();
  contexts.push(adminContext);
  adminContext.setDefaultTimeout(30000);
  const adminPage = await localBrowserLogin(
    adminContext,
    foreign.slug,
    foreign,
  );
  await rememberBrowser(adminContext);
  await view(adminPage, b, foreign, agentB);
  await ssr(adminContext, b, foreign, agentB);
  checks.push("real-local-login-unicode-chooser-footer-ssr-and-hydration");

  step = "browser-oidc";
  const oidcContext = await browser.newContext();
  contexts.push(oidcContext);
  oidcContext.setDefaultTimeout(30000);
  // Route only the fixture's browser-facing authorize hop to its published TLS
  // port. All Identity discovery/token/JWKS and Gateway callback work is real.
  await oidcContext.route(issuer + "/**", async (route) => {
    const destination = new URL(route.request().url());
    assert.equal(destination.pathname, "/authorize");
    assert.equal(route.request().method(), "GET");
    const response = await idp(destination, { account: "local" });
    assert.equal(response.status, 302);
    const callback = new URL(response.headers.location);
    assert.equal(
      callback.origin + callback.pathname,
      gateway + "/protocol/oidc/callback",
    );
    assert.equal(
      callback.searchParams.get("state"),
      destination.searchParams.get("state"),
    );
    secrets.push(
      destination.searchParams.get("state"),
      destination.searchParams.get("nonce"),
      callback.searchParams.get("code"),
    );
    oidcRedirects++;
    await route.fulfill({
      status: 302,
      headers: { location: response.headers.location },
      body: "",
    });
  });
  const oidcPage = await oidcContext.newPage();
  watchBrowser(oidcPage);
  await oidcPage.goto(gateway, { waitUntil: "domcontentloaded" });
  await oidcPage.locator('[name="organization_slug"]').fill(original.slug);
  await oidcPage
    .getByRole("button", {
      name: `Continue with ${method.display_name}`,
      exact: true,
    })
    .click();
  await oidcPage.waitForURL(
    (url) => url.origin === gateway && url.pathname.startsWith("/workspace/"),
  );
  await rememberBrowser(oidcContext);
  const oidcPrincipal = assertOrganizationSession(
    await browserJSON(oidcContext, "/api/session"),
    "session",
    original,
  );
  assert.deepEqual(stablePrincipal(oidcPrincipal), stablePrincipal(a));
  assert.equal(oidcRedirects, 1);
  await view(oidcPage, oidcPrincipal, original, agentA);
  await ssr(oidcContext, oidcPrincipal, original, agentA);
  checks.push(
    "real-ui-oidc-start-verified-tls-idp-callback-and-workspace-render",
  );

  step = "rename";
  const changed = await organizationRow(a.organization_id, {
    slug: "stage3-renamed",
    name: "研发 · Équipe 🚀 <script>display only</script>",
  });
  renamed = true;
  for (const [page, principal] of [
    [localPage, a],
    [oidcPage, oidcPrincipal],
  ]) {
    const message = page.getByRole("combobox", {
      name: "Message",
      exact: true,
    });
    await message.fill("Unsaved draft survives an Organization rename");
    const [response] = await Promise.all([
      page.waitForResponse(
        (value) =>
          new URL(value.url()).pathname === "/api/app/workspace/v1/bootstrap",
      ),
      page
        .getByRole("button", { name: "Refresh workspace", exact: true })
        .click(),
    ]);
    assert.equal(response.status(), 200);
    assertWorkspaceBootstrap(
      await response.json(),
      principal,
      changed,
      [agentA],
      secrets,
    );
    bootstraps++;
    await page
      .locator(".profile-copy small")
      .filter({ hasText: changed.name })
      .waitFor();
    assert.equal(
      await page.locator(".profile-copy small").innerText(),
      changed.name,
    );
    assert.equal(
      await message.inputValue(),
      "Unsaved draft survives an Organization rename",
    );
    assert.equal(new URL(page.url()).pathname, agentPath(agentA));
    const session = assertOrganizationSession(
      await browserJSON(page.context(), "/api/session"),
      "session",
      changed,
    );
    assert.deepEqual(stablePrincipal(session), stablePrincipal(principal));
    await ssr(page.context(), principal, changed, agentA);
    await view(page, principal, changed, agentA);
    assert.equal(
      await page
        .locator("script")
        .filter({ hasText: /^display only$/u })
        .count(),
      0,
      "Organization display became executable HTML",
    );
  }
  await bootstrap(other, b, foreign, [agentB]);
  checks.push(
    "rename-rebootstrap-and-reload-preserve-auth-scope-and-unsaved-draft",
  );

  step = "logout";
  const localCookies = await localContext.cookies();
  const replay = localCookies
    .map((value) => `${value.name}=${value.value}`)
    .join("; ");
  const [loggedOut] = await Promise.all([
    localPage.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === "/api/session" &&
        value.request().method() === "DELETE",
    ),
    localPage.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]);
  assert.equal(loggedOut.status(), 204);
  await browserJSON(localContext, "/api/app/workspace/v1/bootstrap", 401);
  await new GatewayClient(gateway).request("/api/app/workspace/v1/bootstrap", {
    status: 401,
    headers: { Cookie: replay },
  });
  checks.push("browser-logout-and-replayed-cookie-reject-bootstrap");

  step = "inactive-membership";
  const fresh = new GatewayClient(gateway);
  await fresh.request("/api/session/login", {
    body: { organization_slug: changed.slug, email: memberEmail, password },
  });
  remember(fresh);
  const directory = (await admin.request("/api/admin/directory")).body;
  const membership = directory.users.find(
    (value) => value.membership.id === a.membership_id,
  );
  assert(membership, "Ordinary fixture Membership missing");
  const update = {
    email: membership.membership.email,
    display_name: membership.membership.display_name,
    role: "member",
  };
  await admin.request(`/api/admin/directory/memberships/${a.membership_id}`, {
    body: { ...update, active: false },
  });
  await browserJSON(oidcContext, "/api/app/workspace/v1/bootstrap", 401);
  await fresh.request("/api/app/workspace/v1/bootstrap", { status: 401 });
  await bootstrap(other, b, foreign, [agentB]);
  await admin.request(`/api/admin/directory/memberships/${a.membership_id}`, {
    body: { ...update, active: true },
  });
  await browserJSON(oidcContext, "/api/app/workspace/v1/bootstrap", 401);
  checks.push(
    "inactive-local-and-oidc-membership-denied-other-organization-unaffected",
  );
  assert.deepEqual(
    browserProblems,
    [],
    "Browser encountered script or hydration errors",
  );
} catch (error) {
  // URLs/cookies and browser call logs are intentionally not error evidence.
  const pages = [];
  for (const context of contexts)
    for (const page of context.pages()) {
      const url = new URL(page.url());
      pages.push({
        peer:
          url.origin === gateway
            ? "gateway"
            : url.origin === issuer
              ? "idp"
              : "browser",
        path: url.pathname,
        oidc_error: url.searchParams.get("auth_error") === "oidc_login_failed",
        chooser: await page.locator(".chooser-kicker").count(),
        footer: await page.locator(".profile-copy small").count(),
      });
    }
  console.error(
    JSON.stringify({
      event: "organization_display_failed",
      stage: step,
      error: error?.name,
      code: error?.code,
      oidc_redirects: oidcRedirects,
      checks,
      pages,
      browser_requests: browserRequests,
      category:
        /No resource with given identifier|Response body is unavailable/.test(
          error?.message ?? "",
        )
          ? "response-discarded-after-navigation"
          : undefined,
      location: error?.stack
        ?.split("\n")
        .find(
          (line) =>
            line.includes("organization-display-client.mjs:") &&
            line.trim().startsWith("at "),
        )
        ?.trim(),
    }),
  );
  throw new Error(`Organization display integration failed at ${step}`);
} finally {
  for (const context of contexts) await context.close();
  await browser?.close();
  if (renamed) await organizationRow(original.id, original);
}
const observedCanaries = await idp("/fixture/canaries");
assert.equal(observedCanaries.status, 200);
secrets.push(...parseFixtureJSON(observedCanaries.text));
await writeFile(
  canaryPath,
  JSON.stringify({
    ...canaries,
    canaries: [...new Set(secrets.filter(Boolean))],
  }),
  { mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    status: "business_passed",
    suite: "organization-display",
    checks,
    bootstraps,
    ssr_documents: documents,
    real_browser_sessions: 3,
    oidc_authorize_redirects: oidcRedirects,
    model_prompts_submitted: 0,
  }) + "\n",
);
