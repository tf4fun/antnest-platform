import assert from "node:assert/strict";
import { argon2Sync, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { browserClient } from "./browser-sessions-flow.mjs";
import { passwordFixture } from "./password-verification-fixture.mjs";
import {
  assertPasswordRejection,
  assertFifthCommit,
} from "./password-verification-evidence.mjs";
import { assertNoStore } from "../identity-closeout/support.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { startPasswordPressure } from "./password-pressure.mjs";

const originalAdmin = {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
const cookieNames = ["__Host-antnest_session", "__Host-antnest_csrf"];
const keyOf = (row) => row.scope + ":" + row.key;
const attemptMap = (rows) => new Map(rows.map((row) => [keyOf(row), row]));

// Only fixture inputs use a legacy policy. Both deployed Identity engines keep
// their admitted production Argon2 policy and verify this historical PHC.
function legacyHash(password) {
  const salt = randomBytes(16);
  const key = argon2Sync("argon2id", {
    message: password,
    nonce: salt,
    memory: 8192,
    passes: 1,
    parallelism: 1,
    tagLength: 32,
  });
  const b64 = (value) => value.toString("base64").replaceAll("=", "");
  return `$argon2id$v=19$m=8192,t=1,p=1$${b64(salt)}$${b64(key)}`;
}

export async function verifyPasswordVerification({
  browser,
  config,
  docker,
  compose,
  signal,
  output,
  record,
}) {
  const f = await passwordFixture({ config, docker, compose, signal });
  const contexts = [];
  const evidence = {
    complete: false,
    topology: f.topology,
    configuration: f.configuration,
    checks: [],
    concurrency: [],
    public_responses: [],
  };
  const checkpoint = (name) => {
    evidence.checks.push(name);
    record(evidence);
    console.log(
      JSON.stringify({ phase: "password-verification", checking: name }),
    );
  };
  const accountPassword = () => randomBytes(24).toString("base64url");
  const facts = async () =>
    (
      await f.query(`SELECT jsonb_build_object(
    'users',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM users t),
    'credentials',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY user_id),'[]'::jsonb)::text) FROM local_credentials t),
    'memberships',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM organization_memberships t),
    'tokens',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text) FROM api_tokens t),
    'events',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY sequence),'[]'::jsonb)::text) FROM identity_events t),
    'sessions',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY sequence),'[]'::jsonb)::text) FROM session_revocations t),
    'principals',(SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY sequence),'[]'::jsonb)::text) FROM principal_revocations t)
  ) AS value`)
    )[0].value;
  const cookieSnapshot = async (context) =>
    (await context.cookies(config.gateway))
      .filter((row) => cookieNames.includes(row.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  const post = async (session, path, body, status) => {
    const { page, context } = session;
    const csrf =
      (await cookieSnapshot(context)).find((c) => c.name.endsWith("_csrf"))
        ?.value ?? "";
    const settled = await Promise.allSettled([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === path && r.request().method() === "POST",
        { timeout: 30000 },
      ),
      page.evaluate(
        async ({ path, body, csrf }) => {
          const r = await fetch(path, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-Antnest-CSRF-Token": csrf,
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(25000),
          });
          await r.arrayBuffer();
        },
        { path, body, csrf },
      ),
    ]);
    for (const result of settled)
      if (result.status === "rejected") throw result.reason;
    const response = settled[0].value;
    assert.equal(
      response.status(),
      status,
      `${path}: unexpected public status`,
    );
    const headers = new Headers();
    for (const { name, value } of await response.headersArray())
      headers.append(name, value);
    const result = {
      status,
      body: await response.json(),
      headers,
      traceID: headers.get("x-antnest-trace-id"),
    };
    assertNoStore(headers);
    return result;
  };
  const browserSession = async (account) => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    // This same-origin inert document isolates wire/Cookie effects from UI
    // background activity. Existing browser/UI batches cover the product forms.
    await page.goto(`${config.gateway}/status`);
    const session = { context, page, account };
    const initial = await post(session, "/api/session/login", account, 200);
    session.initial = initial.body;
    assert.equal(initial.headers.getSetCookie().length, 2);
    const cookies = await cookieSnapshot(context);
    assert.equal(cookies.length, 2);
    for (const c of cookies) {
      assert.equal(c.secure, true);
      assert.equal(c.httpOnly, c.name.endsWith("_session"));
      assert.equal(c.sameSite, "Lax");
      assert.equal(c.path, "/");
    }
    return session;
  };
  const preserve = async (session, operation, code) => {
    const cookies = await cookieSnapshot(session.context);
    const before = await facts();
    const response = await operation();
    evidence.public_responses.push({
      ...assertPasswordRejection(response, code),
      trace_id: response.traceID,
    });
    assert.deepEqual(
      await cookieSnapshot(session.context),
      cookies,
      "password failure changed real browser Cookies",
    );
    assert.deepEqual(
      await facts(),
      before,
      "password failure changed durable credentials, sessions, directory or events",
    );
    const old = await browserClient(session.context, config.gateway);
    const live = await old.request("/api/session");
    assert.equal(
      live.body.principal.user_id,
      session.initial.principal.user_id,
    );
    assert.equal(live.headers.getSetCookie().length, 0);
    return response;
  };
  try {
    const root = (await f.signIn("a", originalAdmin)).body;
    const makeOrganization = async (name) => {
      const slug = `password-${name}`;
      const { organization } = await f.administer(root, "create-organization", {
        slug,
        name: `Password ${name}`,
        owner_email: originalAdmin.email,
        owner_display_name: "Password fixture owner",
      });
      const session = (
        await f.signIn("a", { ...originalAdmin, organization_slug: slug })
      ).body;
      return { organization, session, slug };
    };
    const makeUser = async (org, name) => {
      const account = {
        organization_slug: org.slug,
        email: `${name}@password.example.test`,
        password: accountPassword(),
      };
      const { user } = await f.administer(org.session, "create-local-user", {
        organization_id: org.organization.id,
        email: account.email,
        display_name: name,
        password: account.password,
        role: "admin",
      });
      return { account, user };
    };
    const org = await makeOrganization("attempts");
    const target = await makeUser(org, "attempts");
    const other = await makeUser(org, "other-account");
    const browserTarget = await browserSession(target.account);
    const baselineAttempts = attemptMap(await f.attempts());
    const wrong = { ...target.account, password: "incorrect-fixture-password" };
    for (let n = 0; n < 4; n++) await f.signIn(n % 2 ? "b" : "a", wrong, 401);
    const beforeRace = await f.attempts();
    const targetKeys = beforeRace.filter(
      (r) => r.failures !== (baselineAttempts.get(keyOf(r))?.failures ?? 0),
    );
    assert.equal(targetKeys.length, 2);
    assert(targetKeys.every((r) => r.failures === 4));
    const unchanged = await facts();
    const raced = await f.ordered({
      lock: "SELECT id FROM users WHERE id=$1 FOR UPDATE",
      values: [target.user.id],
      firstMarker: "FROM users",
      secondMarker: "INSERT INTO credential_attempts",
      first: () => f.signIn("a", wrong, 401),
      second: () => f.signIn("b", wrong, 429),
    });
    assertPasswordRejection(raced.responses[1], "credential_rate_limited");
    const raceRows = await f.attempts();
    assertFifthCommit(beforeRace, raceRows, targetKeys);
    const afterRace = attemptMap(raceRows);
    assert(targetKeys.every((r) => afterRace.get(keyOf(r))?.failures === 5));
    assert.deepEqual(await facts(), unchanged);
    evidence.concurrency.push({
      case: "fifth-sixth-wrong-login",
      ...raced.chain,
      outcomes: [401, 429],
      committed_failures: 5,
    });
    // Public correct password cannot bypass the committed cross-instance lock.
    await preserve(
      browserTarget,
      () => post(browserTarget, "/api/session/login", target.account, 429),
      "credential_rate_limited",
    );
    await delay(1100, undefined, { signal });
    await f.signIn("b", target.account);
    await f.signIn("a", other.account);
    const recovered = attemptMap(await f.attempts());
    for (const r of targetKeys)
      assert.equal(
        recovered.get(keyOf(r))?.failures,
        r.scope === "organization" ? 5 : 0,
      );
    checkpoint("dual-instance-fifth-sixth-and-account-only-reset");

    for (const unknownOrg of [false, true]) {
      const account = {
        organization_slug: unknownOrg
          ? "password-missing-organization"
          : org.slug,
        email: `${unknownOrg ? "missing-org" : "missing-account"}@password.example.test`,
        password: accountPassword(),
      };
      const before = attemptMap(await f.attempts());
      for (let n = 0; n < 5; n++)
        await f.signIn(n % 2 ? "b" : "a", account, 401);
      const committed = await f.attempts();
      const rejected = await f.signIn("b", account, 429);
      assertPasswordRejection(rejected, "credential_rate_limited");
      assert.deepEqual(
        await f.attempts(),
        committed,
        "backoff rejection changed unknown counters",
      );
      const changed = committed.filter(
        (r) => r.failures !== (before.get(keyOf(r))?.failures ?? 0),
      );
      assert.equal(changed.length, 2);
      assert(
        changed.every(
          (r) => r.failures - (before.get(keyOf(r))?.failures ?? 0) === 5,
        ),
      );
    }
    checkpoint("unknown-account-and-organization-parity");

    const changeOrg = await makeOrganization("change");
    const changePeerOrg = await makeOrganization("change-peer");
    const changer = await makeUser(changeOrg, "changer");
    await f.administer(changePeerOrg.session, "add-organization-membership", {
      organization_id: changePeerOrg.organization.id,
      user_id: changer.user.id,
      email: changer.account.email,
      display_name: "Shared changer",
      role: "admin",
    });
    const changingBrowser = await browserSession(changer.account);
    const changeA = (await f.signIn("a", changer.account)).body;
    const changeB = (
      await f.signIn("b", {
        ...changer.account,
        organization_slug: changePeerOrg.slug,
      })
    ).body;
    const cctA = await f.context("a", changeA.access_token),
      cctB = await f.context("b", changeB.access_token);
    const newPassword = accountPassword();
    const wrongChange = (side) =>
      f.rpc(
        side,
        "change-local-password",
        {
          request_id: randomUUID(),
          actor_principal_id: changer.user.id,
          user_id: changer.user.id,
          current_password: "incorrect-fixture-password",
          new_password: newPassword,
        },
        {
          context: side === "a" ? cctA : cctB,
          status: side === "a" ? 400 : 429,
        },
      );
    const beforeChanges = attemptMap(await f.attempts());
    for (let n = 0; n < 4; n++) await wrongChange("a");
    const changeKeys = (await f.attempts()).filter(
      (r) => r.failures !== (beforeChanges.get(keyOf(r))?.failures ?? 0),
    );
    assert.equal(changeKeys.length, 2);
    const beforeChangeRace = await f.attempts();
    const unchangedChange = await facts();
    const changedRace = await f.ordered({
      lock: "SELECT id FROM users WHERE id=$1 FOR UPDATE",
      values: [changer.user.id],
      firstMarker: "FROM users",
      secondMarker: "INSERT INTO credential_attempts",
      first: () => wrongChange("a"),
      second: () => wrongChange("b"),
    });
    assertPasswordRejection(
      changedRace.responses[1],
      "credential_rate_limited",
    );
    assert.deepEqual(await facts(), unchangedChange);
    assert(changeKeys.every((r) => r.failures === 4));
    const changeRaceRows = await f.attempts();
    assertFifthCommit(beforeChangeRace, changeRaceRows, changeKeys);
    const changedCounters = attemptMap(changeRaceRows);
    assert(
      changeKeys.every((r) => changedCounters.get(keyOf(r))?.failures === 5),
    );
    evidence.concurrency.push({
      case: "cross-organization-current-password-limit",
      ...changedRace.chain,
      outcomes: [400, 429],
    });
    await preserve(
      changingBrowser,
      () =>
        post(
          changingBrowser,
          "/api/session/password",
          {
            current_password: changer.account.password,
            new_password: newPassword,
          },
          429,
        ),
      "credential_rate_limited",
    );
    await delay(1100, undefined, { signal });
    const oldCookies = await cookieSnapshot(changingBrowser.context);
    const oldClient = await browserClient(
      changingBrowser.context,
      config.gateway,
    );
    const replacement = await post(
      changingBrowser,
      "/api/session/password",
      { current_password: changer.account.password, new_password: newPassword },
      200,
    );
    assert.equal(
      replacement.body.expires_at,
      changingBrowser.initial.expires_at,
    );
    assert.equal(replacement.headers.getSetCookie().length, 2);
    const replacementCookies = await cookieSnapshot(changingBrowser.context);
    for (const c of oldCookies)
      assert(
        replacementCookies.find((r) => r.name === c.name)?.value !== c.value,
      );
    await oldClient.request("/api/session", { status: 401 });
    await (
      await browserClient(changingBrowser.context, config.gateway)
    ).request("/api/session");
    checkpoint("cross-organization-password-limit-and-atomic-browser-recovery");

    const legacyOrg = await makeOrganization("legacy"),
      legacyPeerOrg = await makeOrganization("legacy-peer");
    const legacy = await makeUser(legacyOrg, "legacy");
    await f.administer(legacyPeerOrg.session, "add-organization-membership", {
      organization_id: legacyPeerOrg.organization.id,
      user_id: legacy.user.id,
      email: legacy.account.email,
      display_name: "Shared legacy user",
      role: "admin",
    });
    const existing = (
      await f.signIn("b", {
        ...legacy.account,
        organization_slug: legacyPeerOrg.slug,
      })
    ).body;
    const installLegacy = async () =>
      f.query(
        "UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1",
        [legacy.user.id, legacyHash(legacy.account.password)],
      );
    const hash = async () =>
      (
        await f.query(
          "SELECT password_hash FROM local_credentials WHERE user_id=$1",
          [legacy.user.id],
        )
      )[0].password_hash;
    await installLegacy();
    const oldHash = await hash();
    const rehash = await f.ordered({
      lock: "LOCK TABLE api_tokens IN SHARE MODE",
      firstMarker: "INSERT INTO api_tokens",
      secondMarker: "FROM local_credentials",
      first: () => f.signIn("a", legacy.account),
      second: () =>
        f.signIn("b", {
          ...legacy.account,
          organization_slug: legacyPeerOrg.slug,
        }),
    });
    assert((await hash()) !== oldHash);
    assert.match(await hash(), /^\$argon2id\$v=19\$m=65536,t=3,p=2\$/u);
    await f.context("b", existing.access_token);
    evidence.concurrency.push({
      case: "legacy-rehash-across-organizations",
      ...rehash.chain,
      outcomes: [200, 200],
      old_session_alive: true,
    });
    await installLegacy();
    const rotateCCT = await f.context("b", existing.access_token);
    const rotatedPassword = accountPassword();
    const rotation = await f.ordered({
      lock: "LOCK TABLE api_tokens IN SHARE MODE",
      firstMarker: "INSERT INTO api_tokens",
      secondMarker: "FROM users",
      first: () => f.signIn("a", legacy.account),
      second: () =>
        f.rpc(
          "b",
          "change-local-password",
          {
            request_id: randomUUID(),
            actor_principal_id: legacy.user.id,
            user_id: legacy.user.id,
            current_password: legacy.account.password,
            new_password: rotatedPassword,
          },
          { context: rotateCCT },
        ),
    });
    assert.equal(rotation.responses[1].body.expires_at, existing.expires_at);
    for (const token of [
      existing.access_token,
      rotation.responses[0].body.access_token,
    ])
      await f.rpc(
        "a",
        "resolve-access-token",
        { access_token: token, profile: "console" },
        { status: 401 },
      );
    await f.context("a", rotation.responses[1].body.access_token);
    await f.signIn("a", legacy.account, 401);
    await f.signIn("b", { ...legacy.account, password: rotatedPassword });
    evidence.concurrency.push({
      case: "legacy-login-before-password-rotation",
      ...rotation.chain,
      outcomes: [200, 200],
      prior_sessions_revoked: true,
    });
    checkpoint("legacy-rehash-and-password-rotation-commit-order");

    await verifyBusy({
      f,
      makeOrganization,
      makeUser,
      browserSession,
      post,
      preserve,
      facts,
      docker,
      config,
      signal,
      evidence,
    });
    checkpoint("real-kdf-busy-through-https-and-console-recovery");
    // This includes every direct request and checks its actual target container.
    for (const side of ["a", "b"]) {
      const logs = await f.logs(side);
      writeEvidenceFile(
        output,
        `password-identity-${side}.ndjson`,
        logs.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      for (const request of f.requests.filter((r) => r.side === side)) {
        const matched = logs.filter(
          (row) =>
            row.trace_id === request.trace_id && row.route === request.route,
        );
        assert.equal(
          matched.length,
          1,
          "direct RPC did not execute exactly once on its assigned Identity",
        );
        assert.equal(matched[0].status_code, request.status);
      }
    }
    evidence.direct_requests = f.requests;
    record(evidence);
  } catch (error) {
    const describe = (e) =>
      [
        e?.stack ?? String(e),
        ...(e?.errors ?? []).map(describe),
        ...(e?.cause ? [describe(e.cause)] : []),
      ].join("\n");
    writeEvidenceFile(output, "password-failure.private.txt", describe(error));
    record(evidence);
    throw error;
  } finally {
    const closed = await Promise.allSettled(
      contexts.map((context) => context.close()),
    );
    const clean = dockerClient(config.env, undefined, 30000);
    const diagnostics = [];
    for (const side of ["a", "b"]) {
      try {
        writeEvidenceFile(
          output,
          `password-identity-${side}.ndjson`,
          (await f.logs(side, clean))
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n",
        );
      } catch (error) {
        diagnostics.push(error);
      }
    }
    await f.close();
    if (diagnostics.length)
      throw new AggregateError(
        diagnostics,
        "password Identity diagnostic capture failed",
      );
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
  evidence.complete = true;
  record(evidence);
  return evidence;
}

async function verifyBusy({
  f,
  makeOrganization,
  makeUser,
  browserSession,
  post,
  preserve,
  facts,
  docker,
  config,
  signal,
  evidence,
}) {
  const loginOrg = await makeOrganization("busy-login"),
    passwordOrg = await makeOrganization("busy-change"),
    createOrg = await makeOrganization("busy-create");
  const loginUser = await makeUser(loginOrg, "busy-login"),
    passwordUser = await makeUser(passwordOrg, "busy-change"),
    creator = await makeUser(createOrg, "busy-creator");
  const loginBrowser = await browserSession(loginUser.account),
    passwordBrowser = await browserSession(passwordUser.account),
    createBrowser = await browserSession(creator.account);
  const changePassword = accountPasswordForBusy();
  const newUser = {
    email: "created-after-pressure@password.example.test",
    display_name: "Manual recovery",
    password: accountPasswordForBusy(),
    role: "member",
  };
  const requests = [
    {
      session: loginBrowser,
      path: "/api/session/login",
      method: "local-login",
      body: loginUser.account,
    },
    {
      session: passwordBrowser,
      path: "/api/session/password",
      method: "change-local-password",
      body: {
        current_password: passwordUser.account.password,
        new_password: changePassword,
      },
    },
    {
      session: createBrowser,
      path: "/api/admin/directory/users",
      method: "create-local-user",
      body: newUser,
    },
  ];
  const beforeProcess = await f.process();
  const protectedAttempts = await f.attempts();
  const before = await facts();
  const pressureOffset = f.requests.length;
  let pressure;
  // CPU quota is an explicit, temporary scheduling control for this fault phase;
  // it never lowers Argon2 cost/budget and is not RSS/default-deployment evidence.
  const originalCPU = await f.cpu();
  assert.deepEqual(
    originalCPU,
    { period: 100000, quota: -1, nano_cpus: 0 },
    "normal deployment must begin without a CPU quota",
  );
  let phaseError;
  try {
    await docker(["update", "--cpu-quota", "50000", f.mainID]);
    evidence.cpu_quota = { original: originalCPU, pressure: await f.cpu() };
    assert.deepEqual(evidence.cpu_quota.pressure, {
      ...originalCPU,
      quota: 50000,
    });
    const tag = randomUUID().replaceAll("-", "");
    pressure = startPasswordPressure({
      signal,
      run: (n) =>
        f.signIn(
          "a",
          {
            organization_slug: `pressure-${tag}-${n}`,
            email: `pressure-${n}@password.example.test`,
            password: "unknown-pressure-password",
          },
          [401, 503],
        ),
    });
    const deadline = performance.now() + 6000;
    while (true) {
      const logs = await f.logs("a");
      const traces = new Set(
        f.requests.slice(pressureOffset).map((row) => row.trace_id),
      );
      const witness = logs.find(
        (row) =>
          row.password_admission_reason === "queue_full" &&
          traces.has(row.trace_id),
      );
      if (witness) {
        evidence.saturation_trace_id = witness.trace_id;
        break;
      }
      assert(
        performance.now() < deadline,
        "KDF queue saturation was not observed",
      );
      await delay(25, undefined, { signal });
    }
    // Each target is sent once, without searching/retrying until it gets a 503.
    const targets = await Promise.allSettled(
      requests.map((r) =>
        preserve(
          r.session,
          () => post(r.session, r.path, r.body, 503),
          "credential_busy",
        ),
      ),
    );
    const targetErrors = targets
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (targetErrors.length)
      throw new AggregateError(
        targetErrors,
        "public password pressure targets failed",
      );
    const responses = targets.map((result) => result.value);
    const logs = await f.logs("a");
    evidence.busy = responses.map((response, n) => {
      const matches = logs.filter(
        (row) =>
          row.trace_id === response.traceID &&
          row.route === `/rpc/identity/${requests[n].method}`,
      );
      assert.equal(
        matches.length,
        1,
        "public busy request must call its owner exactly once",
      );
      assert(
        ["queue_full", "wait_expired"].includes(
          matches[0].password_admission_reason,
        ),
        "database busy cannot prove KDF pressure",
      );
      return {
        route: requests[n].path,
        trace_id: response.traceID,
        reason: matches[0].password_admission_reason,
        calls: 1,
      };
    });
    assert.deepEqual(await facts(), before);
  } catch (error) {
    phaseError = error;
  } finally {
    const stopped = pressure
      ? pressure.stop().then(
          () => ({}),
          (error) => ({ error }),
        )
      : Promise.resolve({});
    // Restore the quota before joining expensive kernels; same process drains.
    const clean = (
      await import("../lifecycle-closeout/docker.mjs")
    ).dockerClient(config.env, undefined, 30000);
    let restoreError;
    try {
      await clean(["update", "--cpu-quota", "-1", f.mainID]);
      const restoredCPU = await f.cpu(clean);
      assert.deepEqual(restoredCPU, originalCPU);
      if (evidence.cpu_quota) evidence.cpu_quota.restored = restoredCPU;
    } catch (error) {
      restoreError = error;
    }
    const { error: pressureError } = await stopped;
    evidence.pressure = pressure?.state();
    const errors = [phaseError, restoreError, pressureError].filter(Boolean);
    if (errors.length)
      throw new AggregateError(
        errors,
        "password pressure phase failed after all requests joined",
      );
  }
  assert.deepEqual(
    await f.process(),
    beforeProcess,
    "capacity recovery restarted or replaced Identity",
  );
  const afterAttempts = attemptMap(await f.attempts());
  // Unknown-login pressure can add account/organization rows, never User
  // password-change rows. Preserve absence as well as pre-existing counters.
  assert.deepEqual(
    [...afterAttempts.values()].filter(
      (row) => row.scope === "password_change_user",
    ),
    protectedAttempts.filter((row) => row.scope === "password_change_user"),
  );
  for (const row of protectedAttempts)
    assert.deepEqual(
      afterAttempts.get(keyOf(row)),
      row,
      "busy incremented a protected attempt bucket",
    );
  assert.deepEqual(await facts(), before);
  for (const r of requests) {
    const result = await post(r.session, r.path, r.body, 200);
    if (r.method === "change-local-password") {
      assert.equal(result.body.expires_at, r.session.initial.expires_at);
      assert.equal(result.headers.getSetCookie().length, 2);
    } else if (r.method === "create-local-user")
      assert.equal(result.headers.getSetCookie().length, 0);
  }
  const count = await f.query(
    "SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id=$1 AND email=$2",
    [createOrg.organization.id, newUser.email],
  );
  assert.equal(
    count[0].n,
    1,
    "manual create-user recovery did not create exactly one user",
  );
  await delay(1200, undefined, { signal });
  const finalLogs = await f.logs("a");
  for (const r of evidence.busy)
    assert.equal(
      finalLogs.filter(
        (row) =>
          row.trace_id === r.trace_id &&
          row.route ===
            `/rpc/identity/${requests.find((v) => v.path === r.route).method}`,
      ).length,
      1,
    );
  assert.deepEqual(
    await f.process(),
    beforeProcess,
    "manual recovery replaced or restarted Identity",
  );
  evidence.busy_recovery = {
    same_process: true,
    created_users: 1,
    cpu_quota_restored: true,
  };
}

function accountPasswordForBusy() {
  return randomBytes(24).toString("base64url");
}
