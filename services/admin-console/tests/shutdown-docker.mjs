import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const label = "io.antnest.console-shutdown-test";

function upstream() {
  let opened = 0;
  let closed = 0;
  const watches = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://upstream").pathname;
    if (path === "/status" || path === "/test/state") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ opened, closed, active: watches.size }));
    } else if (path === "/internal/agents/agent-1/events/watch") {
      opened++;
      watches.add(response);
      response.once("close", () => {
        closed++;
        watches.delete(response);
      });
      response.setHeader("Content-Type", "text/event-stream");
      response.flushHeaders();
    } else {
      response.writeHead(404).end();
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

async function cleanup(project) {
  const { dockerClient, lines } =
    await import("../../../scripts/lifecycle-closeout/docker.mjs");
  const docker = dockerClient(process.env, undefined, 60000);
  const errors = [];
  for (const kind of ["container", "network"]) {
    const listing =
      kind === "container" ? ["ps", "-aq"] : ["network", "ls", "-q"];
    const owned = () =>
      docker([...listing, "--filter", `label=${label}=${project}`]);
    try {
      for (const id of lines(await owned())) {
        await docker(
          kind === "container" ? ["rm", "-f", id] : ["network", "rm", id],
        );
      }
      assert.deepEqual(lines(await owned()), [], `${kind} cleanup incomplete`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Console shutdown cleanup failed");
}

async function run() {
  const { dockerClient } =
    await import("../../../scripts/lifecycle-closeout/docker.mjs");
  const project = `antnest-console-stop-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Console shutdown regression interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timeout = setTimeout(interrupt, 180000);
  const docker = dockerClient(process.env, controller.signal, 180000);
  let failure;
  try {
    await exercise(project, docker, controller.signal);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup(project);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error]) : error;
    }
    clearTimeout(timeout);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (failure) throw failure;
  console.log(
    JSON.stringify({
      project,
      signals: ["SIGTERM", "SIGINT"],
      restart: "passed",
      watchCancellations: 2,
      exitCodes: [0, 0],
      cleanup: "passed",
    }),
  );
}

async function exercise(project, docker, signal) {
  const fixture = fileURLToPath(import.meta.url);
  const backend = `${project}-upstream`;
  const consoleName = `${project}-console`;
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
    consoleName,
    "-e",
    "ANTNEST_IDENTITY_SERVICE_URL=http://upstream:8080",
    "-e",
    "ANTNEST_AGENT_CONTROLLER_URL=http://upstream:8080",
    "-e",
    "ANTNEST_AGENT_ACP_SERVICE_URL=http://upstream:8080",
    "-e",
    "ANTNEST_ADMIN_SHUTDOWN_TIMEOUT=2s",
    "-e",
    "OTEL_SDK_DISABLED=true",
    "antnest/admin-console:local",
  ]);
  const backendURL = await containerURL(docker, backend);
  for (const [index, stopSignal] of ["SIGTERM", "SIGINT"].entries()) {
    if (index) await docker(["start", consoleName]);
    const consoleURL = await containerURL(docker, consoleName);
    await ready(consoleURL, signal);
    const watch = await fetch(
      `${consoleURL}/api/admin/agents/agent-1/events/watch`,
      {
        signal,
        headers: {
          "X-Antnest-User-ID": "user-admin",
          "X-Antnest-Organization-ID": "org-1",
          "X-Antnest-Membership-ID": "member-1",
          "X-Antnest-System-Role": "admin",
          "X-Antnest-Organization-Role": "admin",
        },
      },
    );
    assert.equal(watch.status, 200);
    assert.deepEqual(await readState(backendURL, signal), {
      opened: index + 1,
      closed: index,
      active: 1,
    });
    await docker(["stop", "--signal", stopSignal, "-t", "10", consoleName]);
    assert.equal(await watch.text(), "", "quiet Watch did not close cleanly");
    const [container] = JSON.parse(await docker(["inspect", consoleName]));
    assert.equal(container.State.Running, false);
    assert.equal(container.State.OOMKilled, false);
    assert.equal(container.State.ExitCode, 0, "Console shutdown failed");
    assert.deepEqual(await readState(backendURL, signal), {
      opened: index + 1,
      closed: index + 1,
      active: 0,
    });
    const logs = await docker(["logs", consoleName]);
    assert.doesNotMatch(
      logs,
      /service_failure|invalid_upstream_response|stream_shutdown_failed/,
    );
  }
}

async function containerURL(docker, name) {
  const binding = await docker(["port", name, "8080/tcp"]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  return `http://${binding}`;
}

async function readState(url, signal) {
  const response = await fetch(`${url}/test/state`, { signal });
  assert.equal(response.status, 200);
  return response.json();
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
  throw new Error("Console readiness deadline exceeded");
}

if (process.argv.includes("--upstream")) upstream();
else await run();
