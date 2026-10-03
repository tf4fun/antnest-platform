import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient } from "../../lifecycle-closeout/docker.mjs";
import { createFixture, callerContext } from "./auth-fixture.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
export async function runConsoleAcceptance({
  authentication = true,
  preparation = true,
  shutdown = true,
} = {}) {
  const project = `antnest-console-auth-${randomUUID()}`;
  const evidence = resolve(
    root,
    "artifacts/verification/console-authentication",
    project,
  );
  const credentials = resolve(evidence, "credentials");
  const fixture = createFixture(credentials);
  assert(
    process.getuid() > 0,
    "use a nonroot user for this disposable fixture",
  );
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
          '{"current_password":"old","new_password":"new-password-value"}',
          200,
        ],
        ["application/json; charset=iso-8859-1", "{}", 415],
        ["application/json; profile=other", "{}", 415],
        [
          "application/json",
          '{"current_password":"old","new_password":"new-password-value","new_password":"another-password"}',
          400,
        ],
        [
          "application/json",
          '{"current_password":"old","New_Password":"new-password-value"}',
          400,
        ],
        ["application/json", "null", 400],
        ["application/json", "{} {}", 400],
      ])
        await request("/api/admin/account/password", {
          method: "POST",
          headers: {
            "Content-Type": media,
            "Idempotency-Key": "console-password-key-0001",
          },
          body,
          status,
        });
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
            base + "/api/admin/account/password",
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
      const file = resolve(credentials, "outgoing/agent-controller");
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
