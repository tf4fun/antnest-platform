import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const label = "io.antnest.gateway-shutdown-test";
const routes = [
  "/api/app/agents/agent-1/state/watch",
  "/api/app/agents/agent-1/v1/acp",
  "/api/app/agents/agent-1/acp",
  "/api/admin/agents/agent-1/events/watch",
];

function upstream() {
  let opened = 0;
  let closed = 0;
  const unexpected = [];
  const watches = new Set();
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
    if (path === "/rpc/identity/resolve-access-token") {
      json({
        principal: {
          user_id: "user-admin",
          organization_id: "org-1",
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
      ![statePath, "/v1/acp", routes[3]].includes(path)
    ) {
      unexpected.push({ method: request.method, path });
      response.writeHead(404).end();
      return;
    }
    if ([statePath, "/v1/acp"].includes(path)) {
      assert.equal(request.headers["x-antnest-organization-id"], "org-1");
      assert.equal(request.headers["x-antnest-principal-id"], "user-admin");
      assert.equal(request.headers["x-antnest-agent-id"], "agent-1");
      assert.equal(
        request.headers["x-antnest-agent-access-subject"],
        undefined,
      );
      assert.equal(request.headers.cookie, undefined);
    }
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
  const stop = () => {
    for (const response of watches) response.end();
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(8080, "0.0.0.0");
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

async function exercise(project, docker, signal) {
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
    "1000:1000",
    "--network-alias",
    "upstream",
    "--mount",
    `type=bind,source=${fixture},target=/fixture.mjs,readonly`,
    "node:24-bookworm-slim",
    "node",
    "/fixture.mjs",
    "--upstream",
  ]);
  await docker([
    ...options,
    "--name",
    gateway,
    ...[
      "IDENTITY_SERVICE",
      "AGENT_CONTROLLER",
      "AGENT_ACP",
      "ADMIN_CONSOLE",
      "AGENT_UI",
    ].flatMap((service) => [
      "-e",
      `ANTNEST_${service}_URL=http://upstream:8080`,
    ]),
    "-e",
    "ANTNEST_EDGE_COOKIE_SECURE=false",
    "-e",
    "ANTNEST_EDGE_SHUTDOWN_TIMEOUT=2s",
    "-e",
    "OTEL_SDK_DISABLED=true",
    "antnest/edge-gateway:local",
  ]);
  const image = await docker(["inspect", "--format", "{{.Image}}", gateway]);
  const expectedImage = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "antnest/edge-gateway:local",
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
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Gateway shutdown regression interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 180000);
  let failure, result;
  console.error(`Disposable Gateway shutdown project: ${project}`);
  try {
    result = await exercise(
      project,
      dockerClient(process.env, abort.signal, 180000),
      abort.signal,
    );
  } catch (error) {
    failure = error;
  } finally {
    abort.abort();
    try {
      await cleanup(project, dockerClient(process.env, undefined, 60000));
    } catch (error) {
      failure = failure ? new AggregateError([failure, error]) : error;
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
