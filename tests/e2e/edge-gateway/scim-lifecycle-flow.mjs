import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { login } from "./browser-sessions-flow.mjs";
import { scimLifecycleFixture } from "./scim-lifecycle-fixture.mjs";
import { inspectLifecycleTrace } from "./scim-lifecycle-evidence.mjs";
import { assertAdmissionArchive } from "./login-admission-evidence.mjs";
import { assertNoStore } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { verifyIdentityEvidence } from "../identity-closeout/trace.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

const tokenPath = "/api/admin/provisioning/scim-tokens";
const admin = {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
const patch = (value) => ({
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  Operations: [{ op: "replace", path: "displayName", value }],
});

export async function verifySCIMLifecycle({
  browser,
  config,
  docker,
  compose,
  signal,
  output,
  record = () => {},
}) {
  const directory = join(output, "scim-lifecycle");
  const contexts = [],
    expectations = [],
    secrets = [admin.password];
  const pendingMutations = new Set(),
    failedMutations = [];
  const evidence = {
    complete: false,
    phases: [],
    responses: [],
    rejected_snapshots: [],
    principal_revocations: [],
    trace_reports: [],
    archive_errors: [],
  };
  let fixture, failure;
  const save = () => {
    assertSecretFree(JSON.stringify(evidence), secrets);
    writeEvidenceFile(
      directory,
      "progress.json",
      JSON.stringify(evidence, null, 2),
    );
    record(evidence);
  };
  const phase = (name) => {
    evidence.phases.push(name);
    save();
    console.log(JSON.stringify({ phase: "scim-lifecycle", completed: name }));
  };
  const context = async () => {
    signal.throwIfAborted();
    const value = await browser.newContext({
      proxy: {
        server: "http://127.0.0.1:9",
        bypass: "127.0.0.1,host.docker.internal",
      },
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(value);
    value.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
        pendingMutations.add(request);
    });
    value.on("requestfinished", (request) => pendingMutations.delete(request));
    value.on("requestfailed", (request) => {
      if (pendingMutations.delete(request))
        failedMutations.push(new URL(request.url()).pathname);
    });
    return value;
  };
  const signIn = async (credentials) => {
    const ownContext = await context();
    const session = await login(ownContext, config.gateway, credentials, "/");
    secrets.push(
      ...(await ownContext.cookies(config.gateway)).map(
        (cookie) => cookie.value,
      ),
    );
    return session;
  };
  const quiesce = async () => {
    // Retire documents before comparing whole-Identity state. No current page
    // may send activity or notice acknowledgements inside a refusal snapshot.
    await until(
      () => pendingMutations.size === 0,
      "browser mutations completed before snapshot",
      signal,
      30000,
    );
    for (const value of contexts)
      for (const page of value.pages())
        await page.goto(`${config.gateway}/status`);
    await until(
      () => pendingMutations.size === 0,
      "retired browser mutations drained",
      signal,
      30000,
    );
    assert.deepEqual(
      failedMutations,
      [],
      "interrupted browser mutation leaves the snapshot boundary unproven",
    );
  };
  const action = async (page, button, path, rpcMethod, consoleRoute = path) => {
    signal.throwIfAborted();
    const [result] = await Promise.all([
      page
        .waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path &&
            response.request().method() === "POST",
        )
        .then(async (response) => {
          const bytes = await response.body();
          const body = JSON.parse(bytes.toString("utf8"));
          const headers = new Headers(response.headers());
          const receipt = {
            path,
            method: "POST",
            status: response.status(),
            trace_id: headers.get("x-antnest-trace-id"),
          };
          evidence.responses.push(receipt);
          save();
          assert.equal(response.status(), 200, `Console ${path}`);
          assertNoStore(headers);
          assert.equal((await response.headerValues("set-cookie")).length, 0);
          const sentHeaders = await response.request().allHeaders();
          assert.equal(sentHeaders.origin, new URL(config.gateway).origin);
          assert(
            sentHeaders["x-antnest-csrf-token"],
            "real browser command must carry CSRF",
          );
          assert(sentHeaders.cookie?.includes("__Host-antnest_session="));
          assert.match(receipt.trace_id ?? "", /^[a-f0-9]{32}$/u);
          expectations.push({
            traceID: receipt.trace_id,
            responseBytes: bytes.length,
            method: "POST",
            status: 200,
            route: `/rpc/identity/${rpcMethod.replaceAll("_", "-")}`,
            rpcMethod,
            console: true,
            consoleRoute,
            clientService: "admin-console",
            resolveProfile: "console",
            resolveTTLms: config.resolveTTLMS,
          });
          return { body, sent: response.request().postDataJSON() };
        }),
      button.click(),
    ]);
    return result;
  };
  const openTokens = async (page) => {
    await page.goto(`${config.gateway}/#provisioning`);
    await page
      .getByRole("tab", { name: "Directory sync", exact: true })
      .click();
  };
  const finishIssue = async (page, issued) => {
    assert(
      typeof issued.credential === "string" && issued.credential.length > 0,
      "one-time credential missing",
    );
    secrets.push(issued.credential);
    const receipt = page.getByRole("dialog", {
      name: "SCIM credential issued",
      exact: true,
    });
    await receipt.getByRole("button", { name: "Done", exact: true }).click();
    await receipt.waitFor({ state: "hidden" });
  };
  const issue = async (session, name, days, providerID) => {
    await openTokens(session.page);
    await session.page
      .getByRole("button", { name: "Issue SCIM token", exact: true })
      .click();
    const dialog = session.page.getByRole("dialog", {
      name: "Issue SCIM token",
      exact: true,
    });
    await dialog.getByLabel("Credential name", { exact: true }).fill(name);
    assert.equal(
      await dialog.getByLabel("Lifetime (days)", { exact: true }).inputValue(),
      "90",
    );
    await dialog
      .getByLabel("Lifetime (days)", { exact: true })
      .fill(String(days));
    if (providerID)
      await dialog
        .getByLabel("Login provider", { exact: true })
        .selectOption(providerID);
    await dialog.getByLabel("Read directory", { exact: true }).check();
    await dialog.getByLabel("Provision directory", { exact: true }).check();
    const { body, sent } = await action(
      session.page,
      dialog.getByRole("button", { name: "Issue credential", exact: true }),
      tokenPath,
      "issue_scim_token",
    );
    assert.deepEqual(sent, {
      name,
      scopes: ["scim:read", "scim:write"],
      ...(providerID ? { oidc_provider_id: providerID } : {}),
      expires_in_days: days,
    });
    assert.equal(body.token.oidc_provider_id, providerID ?? null);
    await fixture.assertLifecycle(
      body.token,
      days,
      session.metadata.principal.user_id,
    );
    await finishIssue(session.page, body);
    return body;
  };
  const scim = async (
    credential,
    method,
    path,
    { body, status = 200, version, errorCode, scimType } = {},
  ) => {
    signal.throwIfAborted();
    const before = status >= 400 ? await fixture.snapshot() : undefined;
    const response = await fetch(`${config.gateway}/scim/v2/${path}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${credential.credential}`,
        "content-type": "application/scim+json",
        ...(version === undefined ? {} : { "If-Match": version }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    const text = await response.text();
    const receipt = {
      path: `/scim/v2/${path}`,
      method,
      status: response.status,
      trace_id: response.headers.get("x-antnest-trace-id"),
      token_id: credential.token.id,
      ...(version ? { if_match: version } : {}),
    };
    evidence.responses.push(receipt);
    save();
    assert.equal(response.status, status, `SCIM ${method} ${path}`);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000",
    );
    assert.match(receipt.trace_id ?? "", /^[a-f0-9]{32}$/u);
    const result = text ? JSON.parse(text) : undefined;
    if (status !== 204)
      assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/scim\+json(?:;|$)/u,
      );
    const [collection, id] = path.split("?")[0].split("/");
    let principalRevocation;
    if (method === "DELETE" && status === 204 && collection === "Users" && id) {
      principalRevocation = await fixture.principalRevocation({
        traceID: receipt.trace_id,
        membershipID: id,
        tokenID: credential.token.id,
      });
      evidence.principal_revocations.push(principalRevocation);
      save();
    }
    expectations.push({
      traceID: receipt.trace_id,
      responseBytes: Buffer.byteLength(text),
      method,
      status,
      route: `/scim/v2/${collection}${id ? "/{id}" : ""}`,
      clientService: "edge-gateway",
      ...(errorCode ? { errorCode } : {}),
      ...(principalRevocation
        ? { principalRevocation, scimTokenID: credential.token.id }
        : {}),
    });
    if (status >= 400) {
      assert(
        errorCode,
        "expected rejection needs its explicit safe error code",
      );
      assert.equal(result.status, String(status));
      assert.deepEqual(result.schemas, [
        "urn:ietf:params:scim:api:messages:2.0:Error",
      ]);
      if (scimType) assert.equal(result.scimType, scimType);
      const after = await fixture.snapshot();
      evidence.rejected_snapshots.push({
        trace_id: receipt.trace_id,
        before,
        after,
      });
      assert.equal(
        after,
        before,
        "rejected SCIM request changed domain, token usage, audit or revocation state",
      );
    } else if (status === 204) {
      assert.equal(text, "");
    } else if (["Users", "Groups"].includes(collection)) {
      const resources = method === "GET" && !id ? result.Resources : [result];
      assert(Array.isArray(resources));
      for (const resource of resources) {
        assert.equal(
          resource.meta.resourceType,
          collection === "Users" ? "User" : "Group",
        );
        assert.match(resource.meta.version, /^W\/"(?:0|-?[1-9][0-9]*)"$/u);
      }
      if (!(method === "GET" && !id)) {
        assert.equal(response.headers.get("etag"), result.meta.version);
        receipt.etag = result.meta.version;
        await fixture.assertResource(collection, result);
      }
    }
    save();
    return result;
  };
  const advance = (previous, next) => {
    assert(
      BigInt(next.meta.version.slice(3, -1)) >
        BigInt(previous.meta.version.slice(3, -1)),
      "successful mutation must advance persisted SCIM version",
    );
  };
  try {
    fixture = await scimLifecycleFixture({ config, docker, compose, signal });
    secrets.push(...fixture.secrets);
    const suffix = randomUUID().slice(0, 8);
    const name = `SCIM administrator ${suffix}`;
    const account = {
      organization_slug: "stage3",
      email: `scim-admin-${suffix}@example.test`,
      password: `Scim-${randomUUID()}`,
    };
    secrets.push(account.password);
    const root = await signIn(admin);
    const create = await root.client.request("/api/admin/directory/users", {
      body: {
        email: account.email,
        password: account.password,
        display_name: name,
        role: "admin",
      },
    });
    assert.equal(create.body.user.system_role, "user");
    assert.equal(create.body.membership.role, "admin");
    const issuer = await signIn(account);
    assert.equal(issuer.metadata.principal.system_role, "user");
    assert.equal(issuer.metadata.principal.organization_role, "admin");
    const providers = await issuer.client.request(
      "/api/admin/directory/identity-providers?limit=50",
    );
    const provider = providers.body.providers.find(
      (row) => row.name === "linking-acceptance",
    );
    assert(
      provider,
      "real limited provider chooser must contain the existing linking fixture",
    );
    const a = await issue(issuer, `SCIM lifecycle ${suffix}`, 90, provider.id);
    evidence.issuer = {
      user_id: create.body.user.id,
      membership_id: create.body.membership.id,
      system_role: "user",
      organization_role: "admin",
    };
    evidence.initial_token = a.token;
    await quiesce();
    assert.equal(
      (await scim(a, "GET", "ServiceProviderConfig")).etag.supported,
      true,
    );
    const userBody = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: `scim-user-${suffix}@example.test`,
      displayName: `SCIM user ${suffix}`,
      active: true,
      externalId: `scim-subject-${suffix}`,
    };
    let user = await scim(a, "POST", "Users", { body: userBody, status: 201 });
    const groupBody = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: `SCIM group ${suffix}`,
      members: [{ value: user.id }],
    };
    let group = await scim(a, "POST", "Groups", {
      body: groupBody,
      status: 201,
    });
    for (const [collection, initial, body] of [
      ["Users", user, userBody],
      ["Groups", group, groupBody],
    ]) {
      const path = `${collection}/${initial.id}`;
      assert.deepEqual((await scim(a, "GET", path)).meta, initial.meta);
      const listed = (await scim(a, "GET", collection)).Resources.find(
        (row) => row.id === initial.id,
      );
      assert.equal(listed?.meta.version, initial.meta.version);
      if (collection === "Groups")
        assert.deepEqual(
          listed.members.map((m) => m.value),
          [user.id],
        );
      const replaced = await scim(a, "PUT", path, {
        body: { ...body, displayName: `${collection} replacement` },
        version: initial.meta.version,
      });
      advance(initial, replaced);
      const patched = await scim(a, "PATCH", path, {
        body: patch(`${collection} patch`),
        version: replaced.meta.version,
      });
      advance(replaced, patched);
      assert.equal(patched.displayName, `${collection} patch`);
      for (const method of ["PATCH", "PUT", "DELETE"])
        await scim(a, method, path, {
          ...(method === "DELETE"
            ? {}
            : { body: method === "PATCH" ? patch("stale write") : body }),
          version: initial.meta.version,
          status: 412,
          scimType: "mutability",
          errorCode: "precondition_failed",
        });
      assert.equal(
        (await scim(a, "GET", path)).meta.version,
        patched.meta.version,
      );
      if (collection === "Users") user = patched;
      else group = patched;
    }
    phase("user-group-persisted-versions-and-six-stale-mutations");

    await openTokens(issuer.page);
    const mutations = [];
    const observe = (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.startsWith(tokenPath))
        mutations.push(path);
    };
    issuer.page.on("request", observe);
    const original = await fixture.tokenSnapshot(a.token.id);
    const row = issuer.page.getByRole("row").filter({ hasText: a.token.name });
    await row.getByRole("button", { name: "Rotate", exact: true }).click();
    const rotation = issuer.page.getByRole("dialog", {
      name: "Rotate SCIM token",
      exact: true,
    });
    await rotation.getByLabel("Lifetime (days)", { exact: true }).fill("7");
    const rotated = await action(
      issuer.page,
      rotation.getByRole("button", { name: "Issue replacement", exact: true }),
      tokenPath,
      "issue_scim_token",
    );
    const b = rotated.body;
    await finishIssue(issuer.page, b);
    issuer.page.off("request", observe);
    assert.deepEqual(
      mutations,
      [tokenPath],
      "rotation must issue once without automatically revoking",
    );
    assert.deepEqual(rotated.sent, {
      name: a.token.name,
      scopes: a.token.scopes,
      oidc_provider_id: a.token.oidc_provider_id,
      expires_in_days: 7,
    });
    for (const field of ["name", "scopes", "oidc_provider_id"])
      assert.deepEqual(b.token[field], a.token[field]);
    assert(
      b.token.id !== a.token.id && b.credential !== a.credential,
      "rotation must issue an independent credential",
    );
    assert.notEqual(b.token.expires_at, a.token.expires_at);
    await fixture.assertLifecycle(b.token, 7, create.body.user.id);
    assert.equal(
      await fixture.tokenSnapshot(a.token.id),
      original,
      "issuing the replacement changed the original token",
    );
    evidence.rotation = {
      original: a.token.id,
      replacement: b.token,
      mutations,
      original_row_unchanged: true,
    };
    await quiesce();
    for (const credential of [a, b, a, b]) {
      assert.equal(
        (await scim(credential, "GET", `Users/${user.id}`)).meta.version,
        user.meta.version,
      );
      const updated = await scim(credential, "PATCH", `Users/${user.id}`, {
        body: patch(`overlap-${evidence.responses.length}`),
        version: user.meta.version,
      });
      advance(user, updated);
      user = updated;
    }
    await fixture.assertLifecycle(a.token, 90, create.body.user.id);
    await fixture.assertLifecycle(b.token, 7, create.body.user.id);
    phase("real-console-rotation-preserves-original-and-both-credentials-work");

    await openTokens(issuer.page);
    const inventory = (
      await issuer.client.request(tokenPath)
    ).body.tokens.filter((token) => token.name === a.token.name);
    assert.equal(inventory.length, 2);
    const oldIndex = inventory.findIndex((token) => token.id === a.token.id);
    assert(oldIndex >= 0);
    // The unchanged Console inventory order identifies the two same-name rows.
    const oldRow = issuer.page
      .getByRole("row")
      .filter({ hasText: a.token.name })
      .nth(oldIndex);
    await oldRow.getByRole("button", { name: "Revoke", exact: true }).click();
    await action(
      issuer.page,
      issuer.page
        .getByRole("dialog", { name: "Revoke SCIM token", exact: true })
        .getByRole("button", { name: "Revoke", exact: true }),
      `${tokenPath}/${a.token.id}/revoke`,
      "revoke_scim_token",
      `${tokenPath}/{token_id}/revoke`,
    );
    await quiesce();
    assert.equal(await fixture.revoked(a.token.id), true);
    await scim(a, "GET", "Users", {
      status: 401,
      errorCode: "unauthenticated",
    });
    const afterRevoke = await scim(b, "PATCH", `Users/${user.id}`, {
      body: patch("replacement after explicit revoke"),
      version: user.meta.version,
    });
    advance(user, afterRevoke);
    user = afterRevoke;
    phase("explicit-old-revocation-leaves-replacement-usable");

    const expired = await issue(issuer, `SCIM expiry ${suffix}`, 1);
    await quiesce();
    evidence.expiry_fixture = await fixture.expire(expired.token.id);
    await scim(expired, "GET", "Users", {
      status: 401,
      errorCode: "unauthenticated",
    });
    phase("controlled-minimum-lifetime-expiry-refused-over-https");

    const isolatedAccount = {
      organization_slug: `scim-isolation-${suffix}`,
      email: `scim-isolated-${suffix}@example.test`,
      password: `Scim-${randomUUID()}`,
    };
    secrets.push(isolatedAccount.password);
    const isolatedSeed = await fixture.seedOrganization(
      root,
      isolatedAccount,
      `SCIM isolated ${suffix}`,
    );
    secrets.push(...fixture.secrets);
    const isolated = await signIn(isolatedAccount);
    assert.notEqual(
      isolated.metadata.principal.organization_id,
      issuer.metadata.principal.organization_id,
    );
    const other = await issue(
      isolated,
      `SCIM isolated credential ${suffix}`,
      3,
    );
    await quiesce();
    for (const path of [`Users/${user.id}`, `Groups/${group.id}`]) {
      await scim(other, "GET", path, { status: 404, errorCode: "not_found" });
      await scim(other, "DELETE", path, {
        version: 'W/"0"',
        status: 404,
        errorCode: "not_found",
      });
    }
    assert(
      !(await scim(other, "GET", "Users")).Resources.some(
        (row) => row.id === user.id,
      ),
    );
    assert(
      !(await scim(other, "GET", "Groups")).Resources.some(
        (row) => row.id === group.id,
      ),
    );
    await scim(other, "POST", "Groups", {
      body: { ...groupBody, displayName: "cross-organization reference" },
      status: 400,
      scimType: "invalidValue",
      errorCode: "invalid_reference",
    });
    evidence.isolation = {
      organization_a: issuer.metadata.principal.organization_id,
      organization_b: isolatedSeed.organization.id,
      cross_resource_status: 404,
      cross_member_status: 400,
    };
    phase("independent-organization-read-write-and-membership-isolation");

    const changeRole = async (role) => {
      await root.page.goto(`${config.gateway}/#directory`);
      await root.page
        .getByRole("button", { name: `Edit ${name}`, exact: true })
        .click();
      const dialog = root.page.getByRole("dialog", {
        name: "Edit local membership",
        exact: true,
      });
      await dialog
        .getByLabel("Organization role", { exact: true })
        .selectOption(role);
      const changed = await action(
        root.page,
        dialog.getByRole("button", { name: "Save membership", exact: true }),
        `/api/admin/directory/memberships/${create.body.membership.id}`,
        "update_membership",
        "/api/admin/directory/memberships/{membership_id}",
      );
      assert.equal(changed.body.membership.role, role);
      await quiesce();
    };
    await changeRole("member");
    assert.equal(await fixture.revoked(b.token.id), true);
    await scim(b, "GET", "Users", {
      status: 401,
      errorCode: "unauthenticated",
    });
    const revokedRow = await fixture.tokenSnapshot(b.token.id);
    await changeRole("admin");
    assert.equal(
      await fixture.tokenSnapshot(b.token.id),
      revokedRow,
      "restoring the issuer changed its revoked credential row",
    );
    assert.equal(await fixture.revoked(b.token.id), true);
    await scim(b, "GET", "Users", {
      status: 401,
      errorCode: "unauthenticated",
    });
    // Re-login and issue a new credential to prove authority was restored while
    // the old credential remains revoked. Other organizations remain usable.
    const restored = await signIn(account);
    const fresh = await issue(
      restored,
      `SCIM restored ${suffix}`,
      2,
      provider.id,
    );
    await quiesce();
    await scim(other, "GET", "Users");
    await scim(fresh, "DELETE", `Users/${user.id}`, {
      status: 204,
      version: user.meta.version,
    });
    const emptyGroup = await scim(fresh, "GET", `Groups/${group.id}`);
    advance(group, emptyGroup);
    assert.deepEqual(emptyGroup.members, []);
    await scim(fresh, "DELETE", `Groups/${group.id}`, {
      status: 204,
      version: emptyGroup.meta.version,
    });
    phase("real-admin-demotion-revokes-and-restoration-does-not-revive");

    evidence.trace_reports = await verifyIdentityEvidence(
      config.jaeger,
      expectations,
      secrets,
      {
        directory: join(directory, "traces"),
        signal,
        inspect: inspectLifecycleTrace,
      },
    );
    save();
    assert(
      evidence.trace_reports.every(
        (report) =>
          report.unreviewed_warning_count === 0 &&
          report.unexpected_errors === 0,
      ),
      "SCIM trace diagnostics require review",
    );
    assert.equal(evidence.trace_reports.length, expectations.length);
    phase("real-http-parent-chains-and-expected-rejections-classified");
    evidence.business_complete = true;
  } catch (error) {
    failure = error;
  } finally {
    // Retain actual HTTP envelopes before the parent tears the environment
    // down, including requests whose assertions or trace inspection failed.
    const diagnosticSignal = AbortSignal.timeout(60000);
    const traceIDs = new Set([
      ...evidence.responses.map((row) => row.trace_id).filter(Boolean),
      ...evidence.trace_reports.flatMap((row) => row.source_trace_ids),
    ]);
    for (const id of traceIDs) {
      try {
        assert.match(id, /^[a-f0-9]{32}$/u);
        const response = await fetch(`${config.jaeger}/api/traces/${id}`, {
          signal: diagnosticSignal,
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assertSecretFree(text, secrets);
        writeEvidenceFile(
          join(directory, "final-traces"),
          `${id}.private.json`,
          text,
        );
        const trace = assertAdmissionArchive(JSON.parse(text), id, secrets);
        if (evidence.business_complete) {
          const admitted = JSON.parse(
            readFileSync(join(directory, "traces", `${id}.json`), "utf8"),
          );
          const ordered = (value) => ({
            ...value,
            spans: value.spans.toSorted((a, b) =>
              a.spanID.localeCompare(b.spanID),
            ),
          });
          assert.deepEqual(
            ordered(trace),
            ordered(admitted),
            "final lifecycle trace changed after inspection",
          );
        }
      } catch {
        evidence.archive_errors.push(`trace-${id}`);
      }
    }
    for (const value of contexts) {
      try {
        await value.close();
      } catch {
        evidence.archive_errors.push("browser-context-close");
      }
    }
    try {
      await fixture?.close();
    } catch {
      evidence.archive_errors.push("observer-pool-close");
    }
    evidence.complete = Boolean(
      evidence.business_complete &&
      !failure &&
      evidence.archive_errors.length === 0,
    );
    save();
  }
  if (failure) throw failure;
  assert.deepEqual(
    evidence.archive_errors,
    [],
    "SCIM lifecycle cleanup or diagnostic archive incomplete",
  );
  return evidence;
}
