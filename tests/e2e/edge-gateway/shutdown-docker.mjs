import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const label = "io.antnest.gateway-shutdown-test";
const routes = [
  "/api/app/agents/agent-1/state/watch",
  "/api/app/agents/agent-1/v1/acp",
  "/api/app/agents/agent-1/acp",
  "/api/admin/agents/agent-1/events/watch",
  "/api/app/workspace/v1/agents/agent-1/events",
];

const dependencyPorts = {
  "identity-service": 8080,
  "agent-controller": 8081,
  "agent-acp-service": 8082,
  "admin-console": 8083,
  "agent-ui": 8084,
};

function upstream() {
  const hashes = JSON.parse(readFileSync("/run/auth/hashes.json", "utf8"));
  const context = () => {
    const now = Math.floor(Date.now() / 1000);
    return (
      Buffer.from(
        `{"typ":"antnest-cct+jwt","alg":"EdDSA","kid":"test"}`,
      ).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ iat: now, exp: now + 60 })).toString(
        "base64url",
      ) +
      "." +
      Buffer.alloc(64).toString("base64url")
    );
  };
  let opened = 0;
  let closed = 0;
  const unexpected = [];
  const watches = new Set();
  const servers = Object.entries(dependencyPorts).map(([service, port]) => {
    const server = createServer((request, response) => {
      const path = new URL(request.url, "http://upstream").pathname;
      const json = (value) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (path === "/status" || path === "/test/state") {
        json({ opened, closed, active: watches.size, unexpected });
        return;
      }
      const authorization =
        request.headers["antnest-service-authorization"] ?? "";
      if (
        !authorization.startsWith("Bearer ") ||
        createHash("sha256").update(authorization.slice(7)).digest("hex") !==
          hashes[service]
      ) {
        response.writeHead(401).end();
        return;
      }
      if (path === "/rpc/identity/resolve-access-token") {
        json({
          caller_context: context(),
          principal: {
            user_id: "user-admin",
            organization_id: "org-1",
            organization_slug: "auth-test",
            organization_name: "Authentication Test",
            organization_role: "admin",
            membership_id: "member-1",
            system_role: "admin",
            active: true,
          },
        });
        return;
      }
      const statePath = "/rpc/agent-acp/watch-agent-execution-state";
      if (
        request.method !== (path === statePath ? "POST" : "GET") ||
        ![statePath, "/v1/acp", routes[3], routes[4]].includes(path)
      ) {
        unexpected.push({ method: request.method, path });
        response.writeHead(404).end();
        return;
      }
      if ([statePath, "/v1/acp", routes[4]].includes(path)) {
        assert.equal(request.headers["x-antnest-organization-id"], "org-1");
        assert.equal(request.headers["x-antnest-principal-id"], "user-admin");
        assert.equal(request.headers["x-antnest-agent-id"], "agent-1");
        assert.equal(
          request.headers["x-antnest-agent-access-subject"],
          undefined,
        );
        assert.equal(request.headers.cookie, undefined);
      }
      assert(request.headers["antnest-caller-context"], "missing trusted CCT");
      opened++;
      watches.add(response);
      response.once("close", () => {
        closed++;
        watches.delete(response);
      });
      response.setHeader("Content-Type", "text/event-stream");
      response.flushHeaders();
      if (path === statePath) {
        response.write(
          `event: workspace_state\ndata: ${JSON.stringify({
            agent_id: "agent-1",
            availability: "ready",
            access_allowed: true,
            configuration_revision: "a".repeat(64),
            unavailable_reason: null,
            active_session_id: null,
          })}\n\n`,
        );
      }
    });
    server.listen(port, "0.0.0.0");
    return server;
  });
  const stop = () => {
    for (const response of watches) response.end();
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function cleanup(project, docker) {
  const errors = [];
  for (const kind of ["container", "network"]) {
    try {
      const list =
        kind === "container" ? ["ps", "-aq"] : ["network", "ls", "-q"];
      const owned = async () =>
        (await docker([...list, "--filter", `label=${label}=${project}`]))
          .split(/\s+/)
          .filter(Boolean);
      for (const id of await owned()) {
        await docker(
          kind === "container" ? ["rm", "-f", id] : ["network", "rm", id],
        );
      }
      assert.deepEqual(await owned(), [], `${kind} cleanup incomplete`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Gateway shutdown cleanup failed");
}

async function containerURL(docker, name) {
  const binding = await docker(["port", name, "8080/tcp"]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  return `http://${binding}`;
}

async function ready(url, signal) {
  for (let attempt = 0; attempt < 60; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${url}/status`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      await response.text();
      if (response.status === 200) return;
    } catch {
      signal.throwIfAborted();
    }
    await delay(250, undefined, { signal });
  }
  throw new Error("Gateway readiness deadline exceeded");
}

async function exercise(project, docker, signal, gatewayImage, credentials) {
  const backend = `${project}-upstream`;
  const gateway = `${project}-edge`;
  const fixture = fileURLToPath(import.meta.url);
  await docker([
    "network",
    "create",
    "--label",
    `${label}=${project}`,
    project,
  ]);
  const options = [
    "run",
    "-d",
    "--network",
    project,
    "--label",
    `${label}=${project}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--cpus",
    "0.5",
    "--memory",
    "256m",
    "-p",
    "127.0.0.1::8080",
  ];
  await docker([
    ...options,
    "--name",
    backend,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--network-alias",
    "upstream",
    "--mount",
    `type=bind,source=${fixture},target=/fixture.mjs,readonly`,
    "--mount",
    `type=bind,source=${credentials},target=/run/auth,readonly`,
    "node:24.21.0-bookworm-slim",
    "node",
    "/fixture.mjs",
    "--upstream",
  ]);
  await docker([
    ...options,
    "--name",
    gateway,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--mount",
    `type=bind,source=${credentials},target=/run/auth,readonly`,
    ...Object.entries({
      IDENTITY_SERVICE: 8080,
      AGENT_CONTROLLER: 8081,
      AGENT_ACP: 8082,
      ADMIN_CONSOLE: 8083,
      AGENT_UI: 8084,
    }).flatMap(([service, port]) => [
      "-e",
      `ANTNEST_${service}_URL=http://upstream:${port}`,
    ]),
    ...Object.entries({
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
      ANTNEST_SERVICE_AUTH_CALLERS_FILE: "/run/auth/callers.json",
      ANTNEST_SERVICE_AUTH_TOKEN_DIR: "/run/auth/outgoing",
    }).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-e",
    "ANTNEST_EDGE_COOKIE_SECURE=true",
    "-e",
    "ANTNEST_EDGE_PUBLIC_ORIGIN=http://127.0.0.1",
    "-e",
    "ANTNEST_EDGE_SHUTDOWN_TIMEOUT=2s",
    "-e",
    "OTEL_SDK_DISABLED=true",
    gatewayImage,
  ]);
  const image = await docker(["inspect", "--format", "{{.Image}}", gateway]);
  const expectedImage = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    gatewayImage,
  ]);
  assert.equal(image, expectedImage);
  const backendURL = await containerURL(docker, backend);
  await ready(backendURL, signal);
  for (const [index, stopSignal] of ["SIGTERM", "SIGINT"].entries()) {
    if (index) await docker(["start", gateway]);
    const gatewayURL = await containerURL(docker, gateway);
    await ready(gatewayURL, signal);
    const receives = [];
    for (const path of routes) {
      const response = await fetch(`${gatewayURL}${path}`, {
        signal,
        headers: {
          Cookie: "antnest_session=fixture-token; antnest_csrf=fixture-csrf",
          Accept: "text/event-stream",
          "Acp-Connection-Id": "fixture-connection",
        },
      });
      if (response.status !== 200) {
        const body = await response.text();
        const diagnostic = await fetch(`${backendURL}/test/state`, { signal });
        const state = await diagnostic.text();
        throw new Error(
          `stream did not open: ${path} status=${response.status} response=${body} upstream=${state}`,
        );
      }
      receives.push(
        response.text().then(
          () => true,
          () => false,
        ),
      );
    }
    const state = async () => {
      const response = await fetch(`${backendURL}/test/state`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await state(), {
      opened: (index + 1) * routes.length,
      closed: index * routes.length,
      active: routes.length,
      unexpected: [],
    });
    await docker(["stop", "--signal", stopSignal, "-t", "10", gateway]);
    await Promise.all(receives);
    const exit = JSON.parse(
      await docker([
        "inspect",
        "--format",
        '{"running":{{.State.Running}},"oom":{{.State.OOMKilled}},"exit":{{.State.ExitCode}}}',
        gateway,
      ]),
    );
    assert.deepEqual(exit, { running: false, oom: false, exit: 0 });
    assert.deepEqual(await state(), {
      opened: (index + 1) * routes.length,
      closed: (index + 1) * routes.length,
      active: 0,
      unexpected: [],
    });
    assert.doesNotMatch(
      await docker(["logs", gateway]),
      /service_failure|shutdown HTTP|context deadline exceeded/,
    );
  }
  return {
    image,
    signals: ["SIGTERM", "SIGINT"],
    restart: "passed",
    receiveRoutes: routes.length,
    upstreamCancellations: routes.length * 2,
    exitCodes: [0, 0],
  };
}

async function run() {
  const { dockerClient } = await import("../lifecycle-closeout/docker.mjs");
  const project = `antnest-gateway-stop-${randomUUID().slice(0, 8)}`;
  const gatewayImage =
    process.env.ANTNEST_GATEWAY_TEST_IMAGE ??
    `antnest/gateway-shutdown:${project}`;
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const credentials = resolve(
    root,
    "artifacts/verification/gateway-shutdown",
    project,
    "credentials",
  );
  mkdirSync(resolve(credentials, "outgoing"), { recursive: true, mode: 0o700 });
  const hashes = {};
  for (const service of Object.keys(dependencyPorts)) {
    const token = randomBytes(32).toString("base64url");
    writeFileSync(resolve(credentials, "outgoing", service), token, {
      mode: 0o600,
    });
    hashes[service] = createHash("sha256").update(token).digest("hex");
  }
  writeFileSync(resolve(credentials, "hashes.json"), JSON.stringify(hashes), {
    mode: 0o600,
  });
  writeFileSync(resolve(credentials, "callers.json"), "{}", { mode: 0o600 });
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Gateway shutdown regression interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 180000);
  let failure, result;
  console.error(`Disposable Gateway shutdown project: ${project}`);
  try {
    if (!process.env.ANTNEST_GATEWAY_TEST_IMAGE)
      await dockerClient(
        process.env,
        abort.signal,
        180000,
      )([
        "build",
        "-f",
        resolve(root, "services/edge-gateway/Dockerfile"),
        "-t",
        gatewayImage,
        root,
      ]);
    result = await exercise(
      project,
      dockerClient(process.env, abort.signal, 180000),
      abort.signal,
      gatewayImage,
      credentials,
    );
  } catch (error) {
    failure = error;
    try {
      const logs = await dockerClient(
        process.env,
        undefined,
        30000,
      )(["logs", `${project}-edge`]);
      console.error(`Gateway shutdown diagnostics:\n${logs}`);
    } catch {
      // The container may not have been created yet.
    }
  } finally {
    abort.abort();
    try {
      await cleanup(project, dockerClient(process.env, undefined, 60000));
    } catch (error) {
      failure = failure ? new AggregateError([failure, error]) : error;
    }
    rmSync(credentials, { recursive: true, force: true });
    if (!process.env.ANTNEST_GATEWAY_TEST_IMAGE) {
      try {
        await dockerClient(
          process.env,
          undefined,
          60000,
        )(["image", "rm", "--no-prune", gatewayImage]);
      } catch (error) {
        failure = failure ? new AggregateError([failure, error]) : error;
      }
    }
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (failure) throw failure;
  console.log(
    JSON.stringify({
      status: "passed",
      project,
      ...result,
      cleanup: "verified",
    }),
  );
}

if (process.argv.includes("--upstream")) upstream();
else await run();
