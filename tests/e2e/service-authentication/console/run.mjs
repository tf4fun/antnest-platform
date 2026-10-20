import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient } from "../../lifecycle-closeout/docker.mjs";
import { createFixture, callerContext } from "./auth-fixture.mjs";
import { verifyOIDCLinking } from "./oidc-linking.mjs";
import { verifyPendingNetwork } from "./network-policy.mjs";
import {
  passwordCases,
  passwordCaseEmail,
  passwordCanary,
} from "./password-fixture.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
export async function runConsoleAcceptance({
  authentication = true,
  preparation = true,
  shutdown = true,
  discovery = true,
} = {}) {
  const project = `antnest-console-auth-${randomUUID()}`;
  const evidence = resolve(
    root,
    "artifacts/verification/console-authentication",
    project,
  );
  const credentials = resolve(evidence, "credentials");
  assert(
    process.getuid() > 0,
    "use a nonroot user for this disposable fixture",
  );
  let fixture;
  try {
    fixture = createFixture(credentials);
  } catch (error) {
    rmSync(credentials, { recursive: true, force: true });
    throw error;
  }
  const env = {
    ...process.env,
    CONSOLE_TEST_UID: String(process.getuid()),
    CONSOLE_TEST_GID: String(process.getgid()),
    CONSOLE_TEST_AUTH_DIRECTORY: credentials,
  };
  const compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "--project-name",
    project,
    "-f",
    resolve(root, "tests/e2e/service-authentication/console/compose.yaml"),
  ];
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = setTimeout(stop, 600000);
  const docker = dockerClient(env, controller.signal, 600000);
  let checks = 0,
    complete = false,
    cleaned = false;
  const passwordAdmission = { cases: [], afterStop: null };
  const networkAdmission = { responses: [], calls: [], complete: false };
  try {
    await docker(
      [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120"],
      true,
    );
    const id = await docker([...compose, "ps", "-q", "admin-console"]);
    const [container] = JSON.parse(await docker(["inspect", id]));
    const binding = container.NetworkSettings.Ports["8080/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    let base = `http://127.0.0.1:${binding.HostPort}`;
    const request = async (
      path,
      {
        status = 200,
        code,
        service = fixture.incoming,
        context = callerContext(fixture),
        headers = {},
        method = "GET",
        body,
      } = {},
    ) => {
      const outgoing = { ...headers };
      if (service !== null)
        outgoing["Antnest-Service-Authorization"] = `Bearer ${service}`;
      if (context !== null) outgoing["Antnest-Caller-Context"] = context;
      const response = await fetch(base + path, {
        method,
        headers: outgoing,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      assert.equal(
        response.status,
        status,
        `${method} ${path} returned unexpected status`,
      );
      if (code) assert.equal(JSON.parse(text).code, code);
      assert.equal(response.headers.get("Antnest-Service-Authorization"), null);
      assert.equal(response.headers.get("Antnest-Caller-Context"), null);
      for (const secret of [
        fixture.incoming,
        fixture.forbidden,
        ...Object.values(fixture.tokens),
        context,
      ].filter(Boolean))
        assert(!text.includes(secret), "credential leaked into response");
      checks++;
      return { response, text };
    };
    await docker([
      "exec",
      "--env",
      "HTTP_PROXY=http://127.0.0.1:9",
      "--env",
      "HTTPS_PROXY=http://127.0.0.1:9",
      id,
      "/usr/local/bin/admin-console",
      "--healthcheck",
    ]);
    checks++;
    await assert.rejects(
      docker([
        "exec",
        "--env",
        "ANTNEST_ADMIN_CONSOLE_LISTEN=127.0.0.1:8080",
        id,
        "/usr/local/bin/admin-console",
        "--healthcheck",
      ]),
    );
    checks++;
    const dependencyId = await docker([...compose, "ps", "-q", "dependencies"]);
    const state = async () =>
      JSON.parse(
        await docker([
          "exec",
          dependencyId,
          "node",
          "-e",
          "fetch('http://127.0.0.1:8101/test/state').then(r=>r.text()).then(v=>process.stdout.write(v))",
        ]),
      );
    if (authentication) {
      await request("/status", { service: null, context: null });
      await request("/", {
        service: null,
        context: null,
        status: 401,
        code: "service_unauthenticated",
      });
      await request("/", { context: null });
      await request("/api/admin/directory", {
        service: null,
        context: null,
        status: 401,
        code: "service_unauthenticated",
        headers: {
          "X-Antnest-User-ID": "user-admin",
          "X-Antnest-System-Role": "admin",
          "X-Antnest-Organization-ID": "org-1",
        },
      });
      const missing = await request("/api/admin/directory", {
        service: null,
        status: 401,
        code: "service_unauthenticated",
      });
      assert.equal(
        missing.response.headers.get("www-authenticate"),
        'Bearer realm="antnest-service"',
      );
      checks++;
      const forbidden = await request("/api/admin/directory", {
        service: fixture.forbidden,
        status: 403,
        code: "caller_not_allowed",
      });
      assert.equal(forbidden.response.headers.get("www-authenticate"), null);
      checks++;
      await request("/api/admin/directory", {
        context: null,
        status: 401,
        code: "caller_context_required",
      });
      await request("/api/admin/directory", {
        context: "browser-forgery",
        status: 401,
        code: "caller_context_invalid",
      });
      const now = Math.floor(Date.now() / 1000);
      for (const context of [
        callerContext(fixture, { aud: ["agent-controller"] }),
        callerContext(fixture, { iat: now - 100, exp: now - 40 }),
        callerContext(fixture, { agt: "agent-1" }),
        callerContext(fixture, {}, (raw) =>
          raw.replace('"sub":"user-admin"', '"sub":"user-admin","sub":"spoof"'),
        ),
        callerContext(fixture).replace(/.$/, "="),
      ])
        await request("/api/admin/directory", {
          context,
          status: 401,
          code: "caller_context_invalid",
        });
      await request("/api/admin/agents/agent-1", {
        context: callerContext(fixture, { agt: "agent-2" }),
        status: 401,
        code: "caller_context_invalid",
      });
      await request("/api/admin/directory", {
        context: callerContext(fixture, { org_role: "member" }),
        status: 403,
        code: "forbidden",
        headers: {
          "X-Antnest-System-Role": "admin",
          "X-Antnest-Organization-Role": "admin",
        },
      });
      for (const path of [
        "/api/admin/directory",
        "/api/admin/account",
        "/api/admin/agents",
        "/api/admin/execution-audits",
        "/api/admin/skills",
      ])
        await request(path, {
          headers: {
            "X-Antnest-User-ID": "forged",
            "X-Antnest-Organization-ID": "forged",
            Cookie: "browser=secret",
            Authorization: "Bearer browser-forgery",
          },
        });
      await request("/api/admin/skill-sources/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"query":"review"}',
      });
      await request("/api/admin/not-in-contract", {
        status: 403,
        code: "caller_not_allowed",
      });
      for (const [media, body, status] of [
        [
          "application/json; charset=utf-8",
          '{"email":"new@example.test","display_name":"New user","password":"new-password-value","role":"member"}',
          200,
        ],
        ["application/json; charset=iso-8859-1", "{}", 415],
        ["application/json; profile=other", "{}", 415],
        [
          "application/json",
          '{"email":"new@example.test","display_name":"New user","password":"new-password-value","role":"member","role":"admin"}',
          400,
        ],
        [
          "application/json",
          '{"email":"new@example.test","display_name":"New user","Password":"new-password-value","role":"member"}',
          400,
        ],
        ["application/json", "null", 400],
        ["application/json", "{} {}", 400],
      ])
        await request("/api/admin/directory/users", {
          method: "POST",
          headers: {
            "Content-Type": media,
            "Idempotency-Key": "console-directory-key-0001",
          },
          body,
          status,
        });
      for (const scenario of passwordCases) {
        const context = callerContext(fixture);
        const before = (await state()).passwordAdmission;
        const result = await request("/api/admin/directory/users", {
          method: "POST",
          status: 503,
          context,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `console-password-${scenario.id}`,
            Cookie: "existing=browser-private",
          },
          body: JSON.stringify({
            email: passwordCaseEmail(scenario.id),
            display_name: "Password admission",
            password: passwordCanary,
            role: "member",
          }),
        });
        assert.deepEqual(
          JSON.parse(result.text),
          scenario.valid
            ? {
                code: "credential_busy",
                message: "Password verification is busy",
                retryable: true,
              }
            : {
                code: "identity_unavailable",
                message: "Identity Service is unavailable",
              },
        );
        assert.equal(
          result.response.headers.get("retry-after"),
          scenario.valid ? "1" : null,
        );
        assert.equal(result.response.headers.get("cache-control"), "no-store");
        assert.equal(result.response.headers.get("set-cookie"), null);
        assert(!result.text.includes(passwordCanary));
        const after = (await state()).passwordAdmission;
        assert.equal(after.total, before.total + 1);
        assert.equal(after.created, before.created);
        assert.equal(after.calls[scenario.id], 1);
        assert.equal(
          after.contexts[scenario.id],
          createHash("sha256").update(context).digest("hex"),
        );
        const receipt = {
          id: scenario.id,
          status: result.response.status,
          rpcCalls: 1,
          usersCreated: 0,
          noCookie: true,
          noStore: true,
          recovery: false,
        };
        passwordAdmission.cases.push(receipt);
        await request("/api/admin/directory", {
          context,
          headers: { Cookie: "existing=browser-private" },
        });
        const recovered = await request("/api/admin/directory/users", {
          method: "POST",
          context,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `console-recovery-${scenario.id}`,
          },
          body: JSON.stringify({
            email: `recovered-${scenario.id}@example.test`,
            display_name: "Recovered",
            password: passwordCanary,
            role: "member",
          }),
        });
        assert.equal(JSON.parse(recovered.text).user.id, "created-user");
        assert.equal(recovered.response.headers.get("set-cookie"), null);
        const final = (await state()).passwordAdmission;
        assert.equal(final.total, after.total + 1);
        assert.equal(final.created, after.created + 1);
        assert.equal(final.calls[scenario.id], 1);
        receipt.recovery = true;
        checks++;
      }
      assert(!(await docker(["logs", id])).includes(passwordCanary));
      for (const name of [
        "Antnest-Service-Authorization",
        "Antnest-Caller-Context",
        "Content-Type",
      ]) {
        const headers = {
          "Antnest-Service-Authorization": `Bearer ${fixture.incoming}`,
          "Antnest-Caller-Context": callerContext(fixture),
          "Content-Type": "application/json",
        };
        headers[name] = [headers[name], headers[name]];
        const result = await new Promise((resolve, reject) => {
          const req = httpRequest(
            base + "/api/admin/directory/users",
            { method: "POST", headers, signal: controller.signal },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            },
          );
          req.on("error", reject);
          req.end("{}");
        });
        assert.equal(result, name === "Content-Type" ? 415 : 401);
        checks++;
      }
      const untouched = (await state()).calls;
      await request("/api/admin/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        status: 403,
        code: "caller_not_allowed",
      });
      const sessionPath = "/api/admin/directory/users/target-user/sessions";
      for (const query of [
        "",
        "?limit=0",
        "?limit=101",
        "?limit=01",
        "?limit=1&limit=2",
        "?limit=1&scope=self",
        "?limit=1&organization_id=org-2",
        "?limit=1&after_id=",
      ])
        await request(sessionPath + query, { status: 400 });
      await request(sessionPath + "?limit=1", {
        context: callerContext(fixture, { org_role: "member" }),
        status: 403,
      });
      await request(sessionPath + "/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "session-revoke-scope-0001",
        },
        body: '{"scope":"self","mode":"others"}',
        status: 400,
      });
      assert.equal(
        (await state()).calls,
        untouched,
        "invalid requests and retired password route must have no upstream effects",
      );
      checks++;
      const sessionContext = callerContext(fixture, { sys_role: "admin" });
      const safeSessionRequest = async (path, options = {}) => {
        const result = await request(path, {
          context: sessionContext,
          ...options,
        });
        assert.equal(result.response.headers.get("set-cookie"), null);
        assert.equal(result.response.headers.get("cache-control"), "no-store");
        for (const secret of [
          "private-session-canary",
          "private-token-canary",
          "private-token-hash-canary",
        ])
          assert(
            !result.text.includes(secret),
            "private session fields must be projected out",
          );
        return JSON.parse(result.text);
      };
      const first = await safeSessionRequest(sessionPath + "?limit=1", {
        headers: {
          "X-Antnest-Organization-ID": "org-2",
          Cookie: "browser=secret",
        },
      });
      assert.equal(first.sessions.length, 1);
      assert.equal(first.sessions[0].id, "public-session-01");
      assert.equal(first.sessions[0].organization_id, "org-1");
      assert.equal(
        first.sessions[0].user_agent_hint,
        "<img src=x onerror=alert(1)> Synthetic browser",
      );
      assert.equal(first.next_after_id, "public-session-01");
      assert.deepEqual(
        await safeSessionRequest(sessionPath + "?limit=1"),
        first,
        "inventory reads must preserve activity and both deadlines",
      );
      const second = await safeSessionRequest(
        sessionPath + "?limit=1&after_id=" + first.next_after_id,
      );
      assert.deepEqual(
        second.sessions.map((row) => row.id),
        ["public-session-02"],
      );
      assert.equal(second.next_after_id, undefined);
      const org2Context = callerContext(fixture, {
        org: "org-2",
        mbr: "member-2",
        sys_role: "admin",
      });
      const org2 = await safeSessionRequest(sessionPath + "?limit=100", {
        context: org2Context,
      });
      assert.deepEqual(
        org2.sessions.map((row) => row.id),
        ["public-session-03"],
      );
      for (const [user, status] of [
        ["unavailable", 503],
        ["expired", 401],
        ["missing", 404],
      ])
        await safeSessionRequest(
          `/api/admin/directory/users/${user}/sessions?limit=1`,
          { status },
        );
      const beforeRevoke = (await state()).browserSessions.length;
      const revokeOptions = {
        method: "POST",
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "console-session-revoke-0001",
        },
      };
      await safeSessionRequest(
        "/api/admin/directory/users/unavailable/sessions/revoke",
        { ...revokeOptions, status: 503 },
      );
      assert.equal(
        (await state()).browserSessions.length,
        beforeRevoke + 1,
        "503 mutation must not be retried by Console",
      );
      const revoked = await safeSessionRequest(
        sessionPath + "/revoke",
        revokeOptions,
      );
      assert.deepEqual(revoked, { revoked_count: 2, current_revoked: false });
      assert.deepEqual(
        (await safeSessionRequest(sessionPath + "?limit=100")).sessions,
        [],
      );
      assert.deepEqual(
        await safeSessionRequest(sessionPath + "?limit=100", {
          context: org2Context,
        }),
        org2,
      );
      const calls = (await state()).browserSessions;
      for (const call of calls) {
        assert.equal(call.scope, "organization");
        assert.equal(call.actor_principal_id, "user-admin");
        const expectedContext =
          call.organization === "org-1" ? sessionContext : org2Context;
        assert.equal(
          call.contextDigest,
          createHash("sha256").update(expectedContext).digest("hex"),
        );
        if (call.path.endsWith("revoke-user-sessions"))
          assert.equal(call.mode, "all");
      }
      checks++;
      const file = resolve(credentials, "outgoing/agent-controller");
      const linkingChecks = await verifyOIDCLinking({
        request,
        state,
        fixture,
      });
      checks += linkingChecks;
      checks += await verifyPendingNetwork({
        request,
        state,
        fixture,
        admission: networkAdmission,
        openPeer: () =>
          docker([
            "exec",
            dependencyId,
            "node",
            "-e",
            "fetch('http://127.0.0.1:8101/test/network-open',{method:'POST'}).then(r=>{if(!r.ok)process.exit(1);return r.arrayBuffer()})",
          ]),
      });
      writeFileSync(file + ".next", fixture.next, { mode: 0o600 });
      renameSync(file + ".next", file);
      await request("/api/admin/agents");
      writeFileSync(file, fixture.next + "\n", { mode: 0o600 });
      await request("/api/admin/agents", { status: 503 });
      rmSync(file);
      await request("/api/admin/agents", { status: 503 });
      writeFileSync(file, fixture.next, { mode: 0o600 });
      await request("/api/admin/agents");
    }
    if (discovery) {
      const draftSecret = "synthetic-provider-secret";
      const hash = (value) => createHash("sha256").update(value).digest("hex");
      const context = callerContext(fixture);
      const before = (await state()).discovery.length;
      const happy = await request(
        "/api/admin/provider-connections/happy/models/discovery",
        {
          context,
          headers: {
            Authorization: "Bearer browser-credential",
            Cookie: "browser=credential",
            "X-Antnest-Organization-ID": "forged-org",
          },
        },
      );
      assert.deepEqual(JSON.parse(happy.text), {
        models: [
          {
            model_id: "remote",
            display_name: "Remote",
            context_window: 128000,
            supports_images: false,
          },
        ],
      });
      assert.equal(happy.response.headers.get("cache-control"), "no-store");
      assert(!happy.text.includes(draftSecret));
      checks++;
      for (const [outcome, status, code] of [
        ["forbidden", 422, "provider_endpoint_forbidden"],
        ["unavailable", 503, "provider_endpoint_unavailable"],
        ["failed", 502, "provider_discovery_failed"],
        ["missing", 404, "reference_not_found"],
        ["disabled", 409, "reference_disabled"],
      ]) {
        const result = await request(
          `/api/admin/provider-connections/${outcome}/models/discovery`,
          { status, code, context },
        );
        assert(!result.text.includes(draftSecret));
        assert(!result.text.includes("http://private"));
        checks++;
      }
      const draft = (outcome, extra = {}) =>
        JSON.stringify({
          provider_key: "deepseek",
          base_url: `http://dependencies:8101/${outcome}`,
          credential: { method: "api_key", api_key: draftSecret },
          ...extra,
        });
      const empty = await request("/api/admin/provider-models/discovery", {
        method: "POST",
        context,
        headers: { "Content-Type": "application/json" },
        body: draft("empty"),
      });
      assert.deepEqual(JSON.parse(empty.text), { models: [] });
      checks++;
      const forbidden = await request("/api/admin/provider-models/discovery", {
        method: "POST",
        context,
        headers: { "Content-Type": "application/json" },
        body: draft("forbidden"),
        status: 422,
        code: "provider_endpoint_forbidden",
      });
      assert(!forbidden.text.includes(draftSecret));
      checks++;
      for (const extra of [
        { organization_id: "forged-org" },
        { allow_private_endpoints: true },
      ])
        await request("/api/admin/provider-models/discovery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: draft("empty", extra),
          status: 400,
        });
      await request("/api/admin/provider-connections/happy/models/discovery", {
        context: callerContext(fixture, { org_role: "member" }),
        status: 403,
      });
      const calls = (await state()).discovery.slice(before);
      assert.equal(calls.length, 8);
      for (const call of calls) {
        assert.equal(call.organization, "org-1");
        assert.equal(call.contextDigest, hash(context));
        if (call.path === "/internal/provider-discovery/draft")
          assert.equal(call.credentialDigest, hash(draftSecret));
        else assert.equal(call.credentialDigest, undefined);
      }
      assert(!JSON.stringify(calls).includes(draftSecret));
      const logs = await docker(["logs", id]);
      assert(!logs.includes(draftSecret));
      assert(!logs.includes(context));
      assert(!logs.includes("http://private"));
      checks++;
    }
    if (preparation) {
      const before = (await state()).preparationCalls;
      const path = "/api/admin/agent-skill-preparations/by-idempotency-key";
      for (const [kind, item] of Object.entries(fixture.preparations)) {
        const result = await request(path, {
          headers: { "Idempotency-Key": item.key },
        });
        const value = JSON.parse(result.text);
        assert.equal(result.response.headers.get("cache-control"), "no-store");
        assert.equal(value.kind, kind);
        assert.equal(value.request_id, item.request_id);
        assert.deepEqual(value.progress, {
          verified_packages: 1,
          verified_bytes: 128,
          total_packages: 2,
          total_bytes: 256,
        });
        assert(!result.text.includes("secret"));
        checks++;
      }
      const key = fixture.preparations.create.key;
      await request(path, {
        headers: { "Idempotency-Key": key },
        context: callerContext(fixture, { org: "org-2" }),
        status: 404,
      });
      await request(path, {
        headers: { "Idempotency-Key": key },
        context: callerContext(fixture, { org_role: "member" }),
        status: 403,
      });
      await request(path + "?organization_id=org-2", {
        headers: { "Idempotency-Key": key },
        status: 400,
      });
      assert.equal((await state()).preparationCalls - before, 4);
      checks++;
    }
    if (shutdown) {
      for (const [index, signal] of ["SIGTERM", "SIGINT"].entries()) {
        if (index) {
          await docker(["start", id]);
          const [restarted] = JSON.parse(await docker(["inspect", id]));
          base = `http://127.0.0.1:${restarted.NetworkSettings.Ports["8080/tcp"][0].HostPort}`;
          let ready = false;
          for (let attempt = 0; attempt < 60; attempt++) {
            controller.signal.throwIfAborted();
            try {
              const response = await fetch(base + "/status", {
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(1000),
                ]),
              });
              await response.text();
              if (response.ok) {
                ready = true;
                break;
              }
            } catch {
              controller.signal.throwIfAborted();
            }
            await delay(250, undefined, { signal: controller.signal });
          }
          assert(ready, "restarted Console did not become ready");
        }
        const before = await state();
        const watch = await fetch(
          base + "/api/admin/agents/agent-1/events/watch",
          {
            headers: {
              "Antnest-Service-Authorization": `Bearer ${fixture.incoming}`,
              "Antnest-Caller-Context": callerContext(fixture, {
                agt: "agent-1",
              }),
            },
            signal: controller.signal,
          },
        );
        assert.equal(watch.status, 200);
        assert.equal((await state()).active, 1);
        checks++;
        await docker(["stop", "--signal", signal, "-t", "10", id]);
        assert.equal(await watch.text(), "");
        const [stopped] = JSON.parse(await docker(["inspect", id]));
        assert.equal(stopped.State.Running, false);
        assert.equal(stopped.State.OOMKilled, false);
        assert.equal(stopped.State.ExitCode, 0);
        const after = await state();
        assert.equal(after.active, 0);
        assert.equal(after.opened, before.opened + 1);
        assert.equal(after.closed, before.closed + 1);
        checks++;
        assert.doesNotMatch(
          await docker(["logs", id]),
          /service_failure|stream_shutdown_failed/u,
        );
        checks++;
      }
    }
    if (authentication) {
      const after = (await state()).passwordAdmission;
      for (const scenario of passwordCases)
        assert.equal(after.calls[scenario.id], 1);
      passwordAdmission.afterStop = {
        checkedAfterStop: shutdown,
        calls: after.calls,
      };
      assert(!(await docker(["logs", id])).includes(passwordCanary));
      checks++;
    }
    complete = true;
  } finally {
    clearTimeout(timer);
    controller.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    const cleanup = dockerClient(env, undefined, 120000);
    try {
      writeFileSync(
        resolve(evidence, "console.log"),
        await cleanup([...compose, "logs", "--no-color", "admin-console"]),
        { mode: 0o600 },
      );
    } finally {
      try {
        await cleanup(
          [
            ...compose,
            "down",
            "--volumes",
            "--remove-orphans",
            "--rmi",
            "local",
          ],
          true,
        );
        assert.equal(
          await cleanup([
            "ps",
            "-aq",
            "--filter",
            `label=com.docker.compose.project=${project}`,
          ]),
          "",
        );
        cleaned = true;
      } finally {
        rmSync(credentials, { recursive: true, force: true });
        writeFileSync(
          resolve(evidence, "result.json"),
          JSON.stringify({ project, complete, cleaned, checks }) + "\n",
          { mode: 0o600 },
        );
        if (authentication)
          writeFileSync(
            resolve(evidence, "password-admission.json"),
            JSON.stringify(passwordAdmission, null, 2) + "\n",
            { mode: 0o600 },
          );
        if (authentication)
          writeFileSync(
            resolve(evidence, "network-admission.json"),
            JSON.stringify(networkAdmission, null, 2) + "\n",
            { mode: 0o600 },
          );
      }
    }
  }
  console.log(JSON.stringify({ project, complete, cleaned, checks }));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runConsoleAcceptance();
