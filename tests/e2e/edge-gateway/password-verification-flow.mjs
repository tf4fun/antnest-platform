import assert from "node:assert/strict";
import { argon2Sync, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { browserClient } from "./browser-sessions-flow.mjs";
import { passwordFixture } from "./password-verification-fixture.mjs";
import {
  assertPasswordRejection,
  assertFifthCommit,
  passwordResponseObservation,
  assertPasswordHolderWindow,
  passwordIdentityServer,
  assertHolderFailureCommit,
} from "./password-verification-evidence.mjs";
import { assertNoStore } from "../identity-closeout/support.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { withPasswordHolder } from "./password-pressure.mjs";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";
import { inspectLoginRefusalTransaction } from "./resolve-cache-recovery-http.mjs";

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
function legacyHash(
  password,
  { memory = 8192, passes = 1, parallelism = 1 } = {},
) {
  const salt = randomBytes(16);
  const key = argon2Sync("argon2id", {
    message: password,
    nonce: salt,
    memory,
    passes,
    parallelism,
    tagLength: 32,
  });
  const b64 = (value) => value.toString("base64").replaceAll("=", "");
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(key)}`;
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
    response_observations: [],
    transport_failures: [],
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
      if (result.status === "rejected") {
        evidence.transport_failures.push({
          route: path,
          kind:
            result.reason?.name === "TimeoutError"
              ? "timeout"
              : result.reason?.name === "AbortError"
                ? "aborted"
                : "transport_failed",
        });
        record(evidence);
        throw result.reason;
      }
    const response = settled[0].value;
    const headers = new Headers();
    for (const { name, value } of await response.headersArray())
      headers.append(name, value);
    let responseBody, bodyError;
    try {
      responseBody = await response.json();
    } catch (error) {
      bodyError = error;
    }
    const result = {
      status: response.status(),
      body: responseBody,
      headers,
      traceID: headers.get("x-antnest-trace-id"),
    };
    result.observation = passwordResponseObservation(path, result);
    evidence.response_observations.push(result.observation);
    record(evidence);
    if (bodyError) throw bodyError;
    assert.equal(result.status, status, `${path}: unexpected public status`);
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
    const receipt = assertPasswordRejection(response, code);
    response.observation.rejection_valid = true;
    assert.deepEqual(
      await cookieSnapshot(session.context),
      cookies,
      "password failure changed real browser Cookies",
    );
    response.observation.cookies_preserved = true;
    assert.deepEqual(
      await facts(),
      before,
      "password failure changed durable credentials, sessions, directory or events",
    );
    response.observation.database_preserved = true;
    const old = await browserClient(session.context, config.gateway);
    const live = await old.request("/api/session");
    assert.equal(
      live.body.principal.user_id,
      session.initial.principal.user_id,
    );
    assert.equal(live.headers.getSetCookie().length, 0);
    response.observation.old_session_live = true;
    evidence.public_responses.push({ ...receipt, trace_id: response.traceID });
    record(evidence);
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
      output,
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
  output,
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
  // The holder has its own two pre-existing counters, so its deliberate wrong
  // password cannot contend with or change the three target accounts.
  const beforeHolderOrg = attemptMap(await f.attempts());
  const holderOrg = await makeOrganization("busy-holder");
  const holderUser = await makeUser(holderOrg, "busy-holder");
  const orgKeys = (await f.attempts()).filter(
    (r) => r.scope === "organization" && !beforeHolderOrg.has(keyOf(r)),
  );
  assert.equal(orgKeys.length, 1);
  const beforeHolderLogin = attemptMap(await f.attempts());
  await f.signIn("a", holderUser.account);
  const accountKeys = (await f.attempts()).filter(
    (r) => !beforeHolderLogin.has(keyOf(r)),
  );
  assert.equal(accountKeys.length, 1);
  const holderKeys = new Set([...orgKeys, ...accountKeys].map(keyOf));
  const holderPolicy = { memory: 131072, passes: 10, parallelism: 1 };
  assert.equal(holderPolicy.memory, f.configuration.memory_budget_kib);
  const holderHash = legacyHash(holderUser.account.password, holderPolicy);
  assert.equal(
    (
      await f.query(
        "UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1 RETURNING user_id",
        [holderUser.user.id, holderHash],
      )
    ).length,
    1,
  );
  for (const r of requests) {
    const client = await browserClient(r.session.context, config.gateway);
    await client.request("/api/session");
  }
  const beforeProcess = await f.process();
  const protectedAttempts = await f.attempts();
  const before = await facts();
  const originalCPU = await f.cpu();
  assert.deepEqual(
    originalCPU,
    { period: 100000, quota: -1, nano_cpus: 0 },
    "normal deployment must begin without a CPU quota",
  );
  const clean = dockerClient(config.env, undefined, 30000);
  const query = async () =>
    (
      await f.pool.query(
        "SELECT pid,backend_start::text,xact_start::text,state,wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND application_name='issue60-a' AND xact_start IS NOT NULL",
      )
    ).rows;
  const verifying = (rows) =>
    rows.filter(
      (row) =>
        row.state === "idle in transaction" &&
        row.blockers.length === 0 &&
        row.query.replace(/\s+/gu, " ").trim() ===
          "SELECT password_hash FROM local_credentials WHERE user_id=$1 FOR UPDATE",
    );
  const actualBusy = async (response, method) => {
    const matches = (await f.logs("a", clean)).filter(
      (row) =>
        row.trace_id === response.traceID &&
        row.route === `/rpc/identity/${method}`,
    );
    assert.equal(
      matches.length,
      1,
      "password target must call its actual owner once",
    );
    assert.equal(matches[0].status_code, 503);
    assert.equal(
      matches[0].password_admission_reason,
      "wait_expired",
      "database admission or a past queue-full event cannot prove held KDF capacity",
    );
    return { trace_id: response.traceID, reason: "wait_expired", calls: 1 };
  };
  let holderResponse, probeResponse, holderTransaction, responses;
  evidence.holder = {
    policy: holderPolicy,
    started: 0,
    http_joined: false,
    server_drained: false,
  };
  const attemptsStartedAt = (
    await f.query("SELECT clock_timestamp() AS value")
  )[0].value;
  await withPasswordHolder({
    signal,
    throttle: async () => {
      // Only this bounded scheduling fault uses a CPU quota. Current Argon2
      // policy and resource budgets stay unchanged; this is not RSS evidence.
      await docker(["update", "--cpu-quota", "10000", f.mainID]);
      evidence.cpu_quota = { original: originalCPU, pressure: await f.cpu() };
      assert.deepEqual(evidence.cpu_quota.pressure, {
        ...originalCPU,
        quota: 10000,
      });
    },
    start: async () => {
      evidence.holder.started++;
      holderResponse = await f.signIn(
        "a",
        { ...holderUser.account, password: "incorrect-full-budget-holder" },
        401,
        { traceRoot: true },
      );
      evidence.holder.http_joined = true;
      evidence.holder.trace_id = holderResponse.traceID;
    },
    exercise: async (assertHeld) => {
      while (true) {
        assertHeld();
        const rows = verifying(await query());
        assert(rows.length <= 1, "ambiguous password holder transaction");
        if (rows.length === 1) {
          holderTransaction = rows[0];
          break;
        }
        await delay(25, undefined, { signal });
      }
      evidence.holder.before = holderTransaction;
      assertHeld();
      // A nonempty invalid namespace takes the actual no-database dummy KDF.
      // One wait_expired receipt corroborates admission; it is never retried.
      probeResponse = await f.signIn(
        "a",
        {
          organization_slug: "Invalid namespace!",
          email: "holder-probe@password.example.test",
          password: "invalid-namespace-probe",
        },
        503,
        { traceRoot: true },
      );
      assertPasswordRejection(probeResponse, "credential_busy");
      evidence.holder.probe = await actualBusy(probeResponse, "local-login");
      assertHeld();
      const targets = await Promise.allSettled(
        requests.map((r) =>
          preserve(
            r.session,
            () => post(r.session, r.path, r.body, 503),
            "credential_busy",
          ),
        ),
      );
      const errors = targets
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length)
        throw new AggregateError(
          errors,
          "one-shot public password targets failed",
        );
      responses = targets.map((r) => r.value);
      assertHeld();
      const after = verifying(await query());
      assert.equal(
        after.length,
        1,
        "holder left Verify before target completion",
      );
      assert.deepEqual(
        after[0],
        holderTransaction,
        "holder transaction advanced during targets",
      );
      evidence.holder.after = after[0];
      evidence.busy = [];
      for (let n = 0; n < responses.length; n++)
        evidence.busy.push({
          route: requests[n].path,
          ...(await actualBusy(responses[n], requests[n].method)),
        });
      assertHeld();
      assert.deepEqual(await facts(), before);
    },
    restore: async () => {
      await clean(["update", "--cpu-quota", "-1", f.mainID]);
      const restored = await f.cpu(clean);
      assert.deepEqual(restored, originalCPU);
      if (evidence.cpu_quota) evidence.cpu_quota.restored = restored;
    },
    drain: async () => {
      const deadline = performance.now() + 5000;
      while ((await query()).length) {
        assert(
          performance.now() < deadline,
          "actual Identity transactions did not drain",
        );
        await delay(25);
      }
      if (evidence.holder.started) {
        assert(
          holderResponse,
          "actual holder HTTP completion was not captured",
        );
        const matches = (await f.logs("a", clean)).filter(
          (r) =>
            r.trace_id === holderResponse.traceID &&
            r.route === "/rpc/identity/local-login",
        );
        assert.equal(matches.length, 1);
        assert.equal(matches[0].status_code, 401);
      }
      evidence.holder.server_drained = true;
    },
  });
  assert.deepEqual(
    await f.process(),
    beforeProcess,
    "capacity recovery restarted or replaced Identity",
  );
  const afterAttempts = await f.attempts();
  const attemptBounds = {
    started_at: attemptsStartedAt,
    completed_at: (await f.query("SELECT clock_timestamp() AS value"))[0].value,
  };
  writeEvidenceFile(
    output,
    "password-holder-attempts.private.json",
    JSON.stringify(
      {
        before: protectedAttempts,
        after: afterAttempts,
        holder_keys: [...holderKeys],
        bounds: attemptBounds,
      },
      null,
      2,
    ),
  );
  evidence.holder.attempts = assertHolderFailureCommit(
    protectedAttempts,
    afterAttempts,
    holderKeys,
    attemptBounds,
  );
  assert.deepEqual(await facts(), before);
  const expectations = [
    {
      traceID: holderResponse.traceID,
      method: "local-login",
      status: 401,
      kind: "holder",
    },
    {
      traceID: probeResponse.traceID,
      method: "local-login",
      status: 503,
      kind: "probe",
    },
    ...responses.map((r, n) => ({
      traceID: r.traceID,
      method: requests[n].method,
      status: 503,
      kind: "target",
    })),
  ];
  const traces = new Map();
  evidence.holder.trace_reports = await collectResolveTraceEvidence(
    config.jaeger,
    expectations,
    [
      holderHash,
      holderUser.account.password,
      ...requests.map((r) => r.session.account.password),
      changePassword,
      newUser.password,
    ],
    {
      signal,
      directory: `${output}/password-holder-traces`,
      inspect: (trace, expected) => {
        const server = passwordIdentityServer(
          trace,
          expected.method,
          expected.status,
        );
        if (expected.kind === "holder")
          inspectLoginRefusalTransaction(trace, server);
        if (expected.kind === "probe") assert.equal(trace.spans.length, 1);
        traces.set(trace.traceID, trace);
        return { status: "passed", scope: "password-holder-window" };
      },
    },
  );
  evidence.holder.window = assertPasswordHolderWindow({
    holder: traces.get(holderResponse.traceID),
    probe: traces.get(probeResponse.traceID),
    targets: responses.map((r, n) => ({
      method: requests[n].method,
      trace: traces.get(r.traceID),
    })),
  });
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
