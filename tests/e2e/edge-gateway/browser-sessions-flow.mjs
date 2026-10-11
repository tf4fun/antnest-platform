import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient, assertNoStore } from "../identity-closeout/support.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";

const admin = {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
const nextPassword = "browser-session-replacement-password";
const sessionPath = "/api/session";
const passwordPath = "/api/session/password";
const revokePath = "/api/session/sessions/revoke";
const activityPath = "/api/session/activity";

async function bounded(operation, label = "browser wire inspection") {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} deadline exceeded`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function wireAudit(context, inspectActivity) {
  const pending = new Set(),
    failures = [],
    activities = [],
    streams = [];
  let ordinaryResponses = 0,
    deniedResponses = 0,
    cookieWriters = 0,
    eventStreams = 0;
  const receive = (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/")) return;
    const task = bounded(
      (async () => {
        const status = response.status(),
          method = response.request().method();
        const cookies = await response.headerValues("set-cookie");
        const writer =
          (method === "POST" &&
            status === 200 &&
            ["/api/session/login", passwordPath].includes(path)) ||
          (method === "DELETE" &&
            path === sessionPath &&
            [204, 401].includes(status));
        if (writer) {
          cookieWriters++;
          assert.equal(
            cookies.length,
            2,
            "explicit session transition must write both Cookies",
          );
        } else {
          ordinaryResponses++;
          if (status === 401) deniedResponses++;
          assert.equal(
            cookies.length,
            0,
            "ordinary API response must not write Cookies",
          );
        }
        if (path.endsWith("/events") && status === 200) {
          assert.match(
            (await response.headerValue("content-type")) ?? "",
            /^text\/event-stream\b/u,
          );
          eventStreams++;
          streams.push({ path, received: Date.now() });
        }
        if (path === activityPath) {
          const body =
            inspectActivity && status === 200
              ? await response.json()
              : undefined;
          activities.push({
            status,
            received: Date.now(),
            expires_at: body?.expires_at,
            idle_expires_at: body?.idle_expires_at,
            activity_interval_ms: body?.activity_interval_ms,
          });
        }
      })(),
    ).catch(() =>
      failures.push(
        `${response.request().method()} ${path}: wire contract failed`,
      ),
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  context.on("response", receive);
  return {
    activities,
    streams,
    async settle() {
      await Promise.all([...pending]);
      assert.deepEqual(failures, []);
      return {
        ordinaryResponses,
        deniedResponses,
        cookieWriters,
        eventStreams,
        activityReports: activities.length,
      };
    },
    async close() {
      context.off("response", receive);
      return this.settle();
    },
  };
}

export async function browserClient(context, gateway) {
  const client = new GatewayClient(gateway);
  client.cookies = new Map(
    (await context.cookies(gateway)).map(({ name, value }) => [name, value]),
  );
  return client;
}

async function readSession(client, status = 200) {
  const result = await client.request(sessionPath, { status });
  assertNoStore(result.headers);
  assert.equal(
    result.headers.getSetCookie().length,
    0,
    "session read must not mutate browser delivery",
  );
  return result;
}

export async function login(context, gateway, credentials, path) {
  // Retire the previous document before sharing its Cookie jar with a fresh login.
  for (const page of context.pages()) await page.close();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  // All password-login fixtures here are administrators. Authenticate on the
  // Console first so its document remains alive while we inspect the real
  // response, then open the requested Workspace after that inspection.
  await page.goto(new URL("/", gateway).href);
  for (const [name, value] of Object.entries(credentials))
    await page.locator(`[name="${name}"]`).fill(value);
  const [{ metadata, hsts, cookieHeaders }] = await Promise.all([
    page
      .waitForResponse(
        (value) =>
          new URL(value.url()).pathname === "/api/session/login" &&
          value.request().method() === "POST",
      )
      .then((response) =>
        bounded(
          (async () => {
            assert.equal(response.status(), 200, "real browser login failed");
            // Response reads have their own deadline; page action timeouts do
            // not cover Chromium's response-body lifecycle.
            const metadata = await response.json();
            return {
              metadata,
              hsts: await response.headerValue("strict-transport-security"),
              cookieHeaders: await response.headerValues("set-cookie"),
            };
          })(),
          "browser login response capture",
        ),
      ),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  await page.locator('[name="password"]').waitFor({ state: "hidden" });
  assert(
    metadata.principal.system_role === "admin" ||
      metadata.principal.organization_role === "admin",
    "password-login fixture must remain on the authenticated Console",
  );
  await page.waitForURL(new URL("/", gateway).href, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(hsts, "max-age=31536000");
  const cookies = await bounded(
    context.cookies(gateway),
    "browser login cookie snapshot",
  );
  for (const name of ["__Host-antnest_session", "__Host-antnest_csrf"]) {
    const cookie = cookies.find((value) => value.name === name);
    assert(cookie?.secure, "HTTPS browser Cookies must be Secure");
    assert.equal(cookie.httpOnly, name === "__Host-antnest_session");
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.path, "/");
  }
  assert(
    !cookies.some(({ name }) =>
      ["antnest_session", "antnest_csrf"].includes(name),
    ),
    "legacy Cookie names must be absent",
  );
  assert(
    !/;\s*Domain=/iu.test(cookieHeaders.join("\n")),
    "Host Cookies must not contain Domain",
  );
  if (path === "/") {
    await page.goto(`${gateway}/#directory`);
    await page
      .getByRole("heading", { name: "Directory", exact: true })
      .waitFor();
  } else {
    await page.goto(new URL(path, gateway).href);
    await page
      .getByRole("combobox", { name: "Message", exact: true })
      .waitFor();
  }
  return { page, metadata, client: await browserClient(context, gateway) };
}

async function clickResponse(
  page,
  button,
  path,
  status = 200,
  readBody = true,
) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === path &&
        value.request().method() === "POST",
    ),
    button.click(),
  ]);
  assert.equal(
    response.status(),
    status,
    "browser session control returned an unexpected status",
  );
  await response.finished();
  return readBody ? response.json() : undefined;
}

export async function signedOut(page) {
  await page
    .getByRole("heading", { name: "Welcome back", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Message", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("heading", { name: "Directory", exact: true }).count(),
    0,
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
}

async function account(page) {
  await page
    .getByRole("button", { name: "Account and sessions", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Account and sessions",
    exact: true,
  });
  await dialog.getByLabel("Current password", { exact: true }).waitFor();
  return dialog;
}

// These observers use a real browser's delivered Cookie but have their own
// transport lifetime. A UI unmount/local abort therefore cannot pass revocation.
export async function quietObservers(config, agentID, client, signal) {
  const started = Date.now(),
    stop = new AbortController();
  const observerSignal = AbortSignal.any([signal, stop.signal]);
  const headerTimer = setTimeout(
    () => stop.abort(new Error("SSE admission deadline exceeded")),
    20_000,
  );
  let reader, draining, owner, remoteEnd;
  const close = async () => {
    stop.abort();
    try {
      // A server-side reset puts the reader in an errored state. cancel() then
      // rejects with that same terminal error; draining already records it.
      await reader?.cancel().catch(() => {});
    } finally {
      await draining;
      owner?.close();
      if (owner)
        await until(
          () =>
            owner.closeCode !== undefined ||
            owner.handshakeStatus !== undefined,
          "observer socket cleanup",
          undefined,
          5000,
        );
    }
  };
  try {
    const response = await fetch(
      `${config.gateway}/api/app/workspace/v1/agents/${agentID}/events`,
      {
        headers: {
          Cookie: client.cookie,
          Origin: new URL(config.gateway).origin,
        },
        signal: observerSignal,
      },
    );
    clearTimeout(headerTimer);
    assert.equal(response.status, 200, "quiet SSE admission failed");
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/event-stream\b/u,
    );
    assert.equal(response.headers.getSetCookie().length, 0);
    reader = response.body.getReader();
    draining = (async () => {
      try {
        while (!(await reader.read()).done) {
          /* Drain without retaining private payloads. */
        }
      } catch {
        /* A remote reset is a closed output channel too. */
      } finally {
        if (!observerSignal.aborted) remoteEnd = Date.now();
      }
    })();
    owner = connectOwner(config.gateway, agentID, client.cookie, signal);
    await owner.initialize();
    return {
      beforeMutation() {
        signal.throwIfAborted();
        assert.equal(
          remoteEnd,
          undefined,
          "SSE was already closed before revocation",
        );
        assert.equal(
          owner.closeCode,
          undefined,
          "WSS was already closed before revocation",
        );
        assert(
          Date.now() - started < 20_000,
          "observers must be fresh before revocation",
        );
        return Date.now();
      },
      async revoked(at) {
        await until(
          () => remoteEnd !== undefined && owner.closeCode !== undefined,
          "silent stream revocation",
          signal,
          30_000,
        );
        signal.throwIfAborted();
        assert.equal(
          stop.signal.aborted,
          false,
          "local abort must not count as remote revocation",
        );
        assert.equal(
          owner.closeCode,
          1008,
          "WSS must retire with policy violation",
        );
        const elapsed = Date.now() - at;
        assert(
          elapsed <= 30_000,
          "remote revocation exceeded the 30-second stale bound",
        );
        assert(
          Date.now() - started < 50_000,
          "natural 60-second CCT expiry must not explain revocation",
        );
        return {
          sseClosedAfterMs: remoteEnd - at,
          bothClosedAfterMs: elapsed,
          wssCloseCode: owner.closeCode,
          localAbort: false,
          beforeNaturalCCTExpiry: true,
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(headerTimer);
  }
}

function genuineInput(page, signal) {
  const stop = new AbortController();
  let failure,
    count = 0;
  const done = (async () => {
    try {
      while (!stop.signal.aborted) {
        signal.throwIfAborted();
        await page.mouse.move(110 + (count % 20) * 3, 110);
        count++;
        await delay(400, undefined, {
          signal: AbortSignal.any([stop.signal, signal]),
        });
      }
    } catch (error) {
      if (!stop.signal.aborted) failure = error;
    }
  })();
  return {
    async close() {
      stop.abort();
      await done;
      if (failure) throw failure;
      return count;
    },
  };
}

export async function verifyBrowserSessions({
  browser,
  config,
  fixture,
  signal,
  setIdlePolicy,
  record = () => {},
}) {
  const contexts = [],
    audits = [],
    evidence = { phases: [], wire: [] };
  const recordPhase = (phase) => {
    evidence.phases.push(phase);
    record(evidence);
  };
  const context = async (inspectActivity = false) => {
    const value = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(value);
    const audit = wireAudit(value, inspectActivity);
    audits.push(audit);
    return { context: value, audit };
  };
  const workspace = `/workspace/${fixture.agentID}/`;
  try {
    const directory = await fixture.json("/api/admin/directory");
    const membership = directory.users.find(
      ({ user }) => user.id === fixture.ownerID,
    )?.membership;
    assert(membership, "fixture owner membership is required");
    await fixture.json(`/api/admin/directory/memberships/${membership.id}`, {
      body: {
        email: membership.email,
        display_name: membership.display_name,
        role: "admin",
        active: true,
      },
    });
    const consoleBrowser = await context(),
      workspaceBrowser = await context(),
      adminBrowser = await context();
    let consoleSession = await login(
      consoleBrowser.context,
      config.gateway,
      member,
      "/",
    );
    let workspaceSession = await login(
      workspaceBrowser.context,
      config.gateway,
      member,
      workspace,
    );
    const administrator = await login(
      adminBrowser.context,
      config.gateway,
      admin,
      "/",
    );
    assert.equal(
      consoleSession.metadata.principal.user_id,
      workspaceSession.metadata.principal.user_id,
    );
    assert(
      Date.parse(consoleSession.metadata.idle_expires_at) - Date.now() >
        120_000,
      "revocation phase requires a long idle deadline",
    );
    const oldConsole = consoleSession.client,
      oldWorkspace = workspaceSession.client;

    await consoleSession.page
      .getByRole("button", { name: "Change local password" })
      .click();
    const password = consoleSession.page.getByRole("dialog", {
      name: "Local password",
      exact: true,
    });
    await password
      .getByLabel("Current password", { exact: true })
      .fill("incorrect-password");
    await password
      .getByLabel("New password", { exact: true })
      .fill(nextPassword);
    await password
      .getByLabel("Confirm new password", { exact: true })
      .fill(nextPassword);
    const invalid = await clickResponse(
      consoleSession.page,
      password.getByRole("button", { name: "Update password" }),
      passwordPath,
      400,
    );
    assert.equal(invalid.code, "invalid_current_password");
    await password
      .getByRole("alert")
      .getByText("Current password is incorrect")
      .waitFor();
    assert(
      (await browserClient(consoleBrowser.context, config.gateway)).cookie ===
        oldConsole.cookie,
      "failed password change must retain Cookie delivery",
    );
    await readSession(oldConsole);
    await readSession(oldWorkspace);
    await password
      .getByLabel("Current password", { exact: true })
      .fill(member.password);
    console.log(
      JSON.stringify({
        phase: "browser-sessions",
        checking: "password-revocation",
      }),
    );
    let observers = await quietObservers(
      config,
      fixture.agentID,
      oldWorkspace,
      signal,
    );
    try {
      const at = observers.beforeMutation();
      const replacement = await clickResponse(
        consoleSession.page,
        password.getByRole("button", { name: "Update password" }),
        passwordPath,
      );
      assert.equal(replacement.expires_at, consoleSession.metadata.expires_at);
      await password.waitFor({ state: "hidden" });
      await consoleSession.page
        .getByRole("heading", { name: "Directory", exact: true })
        .waitFor();
      const current = await browserClient(
        consoleBrowser.context,
        config.gateway,
      );
      assert(
        current.cookie !== oldConsole.cookie &&
          current.csrf !== oldConsole.csrf,
        "password success must replace both session and CSRF delivery",
      );
      assert.equal(
        (await readSession(current)).body.expires_at,
        consoleSession.metadata.expires_at,
      );
      await readSession(oldConsole, 401);
      await readSession(oldWorkspace, 401);
      const streams = await observers.revoked(at);
      await signedOut(workspaceSession.page);
      await readSession(administrator.client);
      consoleSession.client = current;
      recordPhase({
        name: "password",
        rejectedIncorrectPassword: true,
        inheritedAbsoluteExpiry: true,
        replacedBothCookies: true,
        oldCallerAndPeerDenied: true,
        peerPrivateUIRetired: true,
        independentActorPreserved: true,
        streams,
      });
    } finally {
      await observers.close();
    }
    console.log(
      JSON.stringify({ phase: "browser-sessions", verified: "password" }),
    );

    const credentials = { ...member, password: nextPassword };
    workspaceSession = await login(
      workspaceBrowser.context,
      config.gateway,
      credentials,
      workspace,
    );
    let dialog = await account(workspaceSession.page);
    await dialog
      .getByRole("button", { name: "Sign out other sessions", exact: true })
      .click();
    observers = await quietObservers(
      config,
      fixture.agentID,
      consoleSession.client,
      signal,
    );
    try {
      const at = observers.beforeMutation();
      const result = await clickResponse(
        workspaceSession.page,
        dialog.getByRole("button", { name: "Confirm sign out other sessions" }),
        revokePath,
      );
      assert.equal(result.current_revoked, false);
      assert(result.revoked_count >= 1);
      await readSession(consoleSession.client, 401);
      await readSession(workspaceSession.client);
      await readSession(administrator.client);
      const streams = await observers.revoked(at);
      // Directory has no background observer. The next genuine input observes
      // its 401 through the production activity client and retires private state.
      await consoleSession.page.mouse.move(215, 150);
      await signedOut(consoleSession.page);
      await dialog
        .getByRole("button", { name: "Close account and sessions" })
        .click();
      recordPhase({
        name: "self-others",
        currentPreserved: true,
        peerDenied: true,
        consoleRetiredOnNextInput: true,
        independentActorPreserved: true,
        streams,
      });
    } finally {
      await observers.close();
    }

    consoleSession = await login(
      consoleBrowser.context,
      config.gateway,
      credentials,
      "/",
    );
    await administrator.page
      .getByRole("button", { name: "Manage C4 member browser sessions" })
      .filter({ visible: true })
      .click();
    dialog = administrator.page.getByRole("dialog", {
      name: "C4 member browser sessions",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Revoke organization sessions" })
      .click();
    observers = await quietObservers(
      config,
      fixture.agentID,
      workspaceSession.client,
      signal,
    );
    try {
      const at = observers.beforeMutation();
      const result = await clickResponse(
        administrator.page,
        dialog.getByRole("button", { name: "Confirm revocation" }),
        `/api/admin/directory/users/${fixture.ownerID}/sessions/revoke`,
      );
      assert.equal(result.current_revoked, false);
      assert(result.revoked_count >= 2);
      await readSession(consoleSession.client, 401);
      await readSession(workspaceSession.client, 401);
      await readSession(administrator.client);
      const streams = await observers.revoked(at);
      await signedOut(workspaceSession.page);
      await dialog
        .getByText("No active sessions in this page.", { exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      recordPhase({
        name: "organization-admin",
        targetSessionsDenied: true,
        independentActorPreserved: true,
        peerPrivateUIRetired: true,
        streams,
      });
    } finally {
      await observers.close();
    }

    consoleSession = await login(
      consoleBrowser.context,
      config.gateway,
      credentials,
      "/",
    );
    workspaceSession = await login(
      workspaceBrowser.context,
      config.gateway,
      credentials,
      workspace,
    );
    dialog = await account(workspaceSession.page);
    await dialog
      .getByRole("button", { name: "Sign out all sessions", exact: true })
      .click();
    // The successful current-session revocation navigates immediately. Its
    // response body can leave CDP before Playwright reads it, so prove the
    // effect with both original Cookies and the real UI transition instead.
    await clickResponse(
      workspaceSession.page,
      dialog.getByRole("button", { name: "Confirm sign out all sessions" }),
      revokePath,
      200,
      false,
    );
    await readSession(consoleSession.client, 401);
    await readSession(workspaceSession.client, 401);
    await signedOut(workspaceSession.page);
    await readSession(administrator.client);
    recordPhase({
      name: "self-all",
      currentAndPeerDenied: true,
      currentPrivateUIRetired: true,
      independentActorPreserved: true,
    });
    for (const value of contexts) await value.close();
    console.log(
      JSON.stringify({
        phase: "browser-sessions",
        verified: "self-and-admin-revocation",
      }),
    );

    await setIdlePolicy("5s");
    const active = await context(true),
      passive = await context();
    const activeSession = await login(
      active.context,
      config.gateway,
      credentials,
      "/",
    );
    const pump = genuineInput(activeSession.page, signal);
    try {
      const passiveSession = await login(
        passive.context,
        config.gateway,
        credentials,
        workspace,
      );
      await until(
        () =>
          passive.audit.streams.some(
            ({ path }) =>
              path === `/api/app/workspace/v1/agents/${fixture.agentID}/events`,
          ),
        "passive browser SSE established",
        signal,
        4000,
      );
      await passive.audit.settle();
      const baselineActivity = passive.audit.activities.length;
      const initialPassive = (await readSession(passiveSession.client)).body;
      const start = Date.now();
      assert(
        Date.parse(initialPassive.idle_expires_at) - start <= 5000,
        "short idle policy was not applied",
      );
      assert(
        activeSession.metadata.activity_interval_ms <= 1667,
        "short idle activity hint must permit renewal",
      );
      let passiveReads = 0,
        successfulPassiveReads = 0,
        expired = false;
      while (Date.now() - start < 12_000) {
        const read = await readSession(passiveSession.client, [200, 401]);
        passiveReads++;
        if (read.status === 200) {
          assert.equal(
            expired,
            false,
            "ordinary reads must not revive an expired session",
          );
          successfulPassiveReads++;
          assert.equal(
            read.body.idle_expires_at,
            initialPassive.idle_expires_at,
            "background reads must not renew idle",
          );
          assert.equal(read.body.expires_at, initialPassive.expires_at);
        } else expired = true;
        await delay(400, undefined, { signal });
      }
      assert(
        expired && successfulPassiveReads > 0,
        "passive browser must cross a real idle boundary",
      );
      const current = (await readSession(activeSession.client)).body;
      assert.equal(current.expires_at, activeSession.metadata.expires_at);
      assert(
        Date.parse(current.idle_expires_at) >
          Date.parse(activeSession.metadata.idle_expires_at) + 8000,
        "genuine input must renew across multiple idle windows",
      );
      assert(
        (await browserClient(active.context, config.gateway)).cookie ===
          activeSession.client.cookie,
        "activity must not replace browser Cookies",
      );
      await signedOut(passiveSession.page);
      assert.equal(
        new URL(passiveSession.page.url()).searchParams.get("return_to"),
        workspace,
      );
      await readSession(passiveSession.client, 401);
      const activeWire = await active.audit.settle(),
        passiveWire = await passive.audit.settle();
      assert(
        active.audit.activities.filter(({ status }) => status === 200).length >=
          3,
        "genuine browser input must produce successful activity reports",
      );
      for (const report of active.audit.activities.filter(
        ({ status }) => status === 200,
      ))
        assert.equal(report.expires_at, activeSession.metadata.expires_at);
      assert.equal(
        passive.audit.activities.length,
        baselineActivity,
        "background observer must not report user activity",
      );
      assert(
        passiveWire.eventStreams > 0,
        "passive browser must own a real application event stream",
      );
      recordPhase({
        name: "five-second-idle",
        elapsedMs: Date.now() - start,
        passiveReads,
        successfulPassiveReads,
        passiveDenied: true,
        passivePrivateUIRetiredWithoutInput: true,
        backgroundActivityReports: 0,
        activeActivityReports: activeWire.activityReports,
        activeIdleRenewed: true,
        absoluteExpiryPreserved: true,
        cookiesPreserved: true,
      });
    } finally {
      await pump.close();
    }
    console.log(
      JSON.stringify({
        phase: "browser-sessions",
        verified: "five-second-idle",
      }),
    );
    for (const audit of audits) evidence.wire.push(await audit.close());
    return { complete: true, ...evidence };
  } finally {
    for (const value of contexts) await value.close();
    for (const audit of audits) await audit.close();
  }
}
