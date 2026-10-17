import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const label = "io.antnest.gateway-shutdown-test";
const routes = [
  "/api/app/workspace/v1/agents/agent-1/events",
  "/api/app/workspace/v1/agents/agent-2/events",
  "/api/app/workspace/v1/agents/agent-3/events",
  "/api/admin/agents/agent-1/events/watch",
  "/api/admin/agents/agent-2/events/watch",
];

const dependencyPorts = {
  "identity-service": 8080,
  "admin-console": 8083,
  "agent-ui": 8084,
};

function upstream() {
  const hashes = JSON.parse(readFileSync("/run/auth/hashes.json", "utf8"));
  const now = Date.now();
  const metadata = {
    expires_at: new Date(now + 3600000).toISOString(),
    idle_expires_at: new Date(now + 1800000).toISOString(),
    activity_interval_ms: 30000,
  };
  const context = () => {
    const now = Math.floor(Date.now() / 1000);
    return (
      Buffer.from(
        `{"typ":"antnest-cct+jwt","alg":"EdDSA","kid":"test"}`,
      ).toString("base64url") +
      "." +
      Buffer.from(
        JSON.stringify({ iat: now, exp: now + 60, sid: "fixture-token-id" }),
      ).toString("base64url") +
      "." +
      Buffer.alloc(64).toString("base64url")
    );
  };
  let opened = 0;
  let closed = 0;
  const unexpected = [];
  const watches = new Set();
  const servers = Object.entries(dependencyPorts).map(([service, port]) => {
    const server = createServer(async (request, response) => {
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
          ...metadata,
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
      if (path === "/rpc/identity/list-session-revocations") {
        assert(
          !request.headers["antnest-caller-context"],
          "workload feed received browser CCT",
        );
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          assert(body.length <= 65536);
        }
        const input = JSON.parse(body);
        assert.equal(input.after_sequence, 0);
        assert.equal(input.limit, 500);
        json({ events: [], next_sequence: input.after_sequence });
        return;
      }
      const bridge = path.startsWith("/api/app/workspace/v1/");
      if (
        request.method !== "GET" ||
        !routes.includes(path) ||
        service !== (bridge ? "agent-ui" : "admin-console")
      ) {
        unexpected.push({ method: request.method, path });
        response.writeHead(404).end();
        return;
      }
      const agent = path.split("/")[bridge ? 6 : 4];
      assert.equal(request.headers["x-antnest-organization-id"], "org-1");
      assert.equal(request.headers["x-antnest-user-id"], "user-admin");
      assert.equal(request.headers["x-antnest-membership-id"], "member-1");
      if (bridge) {
        assert.equal(request.headers["x-antnest-principal-id"], "user-admin");
        assert.equal(request.headers["x-antnest-agent-id"], agent);
        assert.equal(request.headers["x-antnest-administrator"], "true");
      } else {
        assert.equal(request.headers["x-antnest-principal-id"], undefined);
        assert.equal(request.headers["x-antnest-agent-id"], undefined);
        assert.equal(request.headers["x-antnest-system-role"], "admin");
        assert.equal(request.headers["x-antnest-organization-role"], "admin");
      }
      assert.equal(
        request.headers["x-antnest-agent-access-subject"],
        undefined,
      );
      assert.equal(request.headers.cookie, undefined);
      assert(request.headers["antnest-caller-context"], "missing trusted CCT");
      opened++;
      watches.add(response);
      response.once("close", () => {
        closed++;
        watches.delete(response);
      });
      response.setHeader("Content-Type", "text/event-stream");
      response.flushHeaders();
      response.write("event: ready\ndata: {}\n\n");
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
          kind === "container" ? ["rm", "-f", "-v", id] : ["network", "rm", id],
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

async function containerURL(docker, name, port = 8080) {
  const binding = await docker(["port", name, `${port}/tcp`]);
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

async function processIdentity(base, traceID, host, output, signal) {
  const { evidenceFilePath } = await import("../../support/storage.mjs");
  for (let attempt = 0; attempt < 60; attempt++) {
    signal.throwIfAborted();
    const response = await fetch(`${base}/api/traces/${traceID}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    const body = await response.json();
    if (response.ok && body.data?.length === 1) {
      writeFileSync(
        evidenceFilePath(output, `${traceID}.json`),
        JSON.stringify(body),
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      const trace = body.data[0];
      assert.equal(trace.traceID, traceID);
      const processes = Object.values(trace.processes).filter(
        (p) => p.serviceName === "edge-gateway",
      );
      assert.equal(processes.length, 1);
      const fields = Object.fromEntries(
        processes[0].tags.map(({ key, value }) => [key, value]),
      );
      assert.equal(Object.keys(fields).length, processes[0].tags.length);
      assert.equal(fields["host.name"], host);
      assert.equal(fields["process.pid"], 1);
      assert.equal(typeof fields["service.instance.id"], "string");
      assert(fields["service.instance.id"]);
      assert.notEqual(fields["service.instance.id"], "forged-instance");
      return fields["service.instance.id"];
    }
    assert([200, 404].includes(response.status));
    await delay(250, undefined, { signal });
  }
  throw new Error("Gateway process identity Trace was not exported");
}

async function exercise(
  project,
  docker,
  signal,
  gatewayImage,
  credentials,
  traceOutput,
) {
  const backend = `${project}-upstream`;
  const gateway = `${project}-edge`;
  const collector = `${project}-collector`;
  mkdirSync(traceOutput, { recursive: true, mode: 0o700 });
  const fixture = fileURLToPath(import.meta.url);
  await docker([
    "network",
    "create",
    "--label",
    `${label}=${project}`,
    project,
  ]);
  await docker([
    "run",
    "-d",
    "--network",
    project,
    "--network-alias",
    "collector",
    "--label",
    `${label}=${project}`,
    "--name",
    collector,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-p",
    "127.0.0.1::16686",
    "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0",
  ]);
  const collectorURL = await containerURL(docker, collector, 16686);
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
      ANTNEST_EDGE_CSRF_KEY_FILE: "/run/auth/csrf.key",
    }).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-e",
    "ANTNEST_EDGE_COOKIE_SECURE=true",
    "-e",
    "ANTNEST_EDGE_PUBLIC_ORIGIN=http://127.0.0.1",
    "-e",
    "ANTNEST_EDGE_SHUTDOWN_TIMEOUT=2s",
    "-e",
    "OTEL_TRACES_EXPORTER=otlp",
    "-e",
    "OTEL_METRICS_EXPORTER=none",
    "-e",
    "OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318",
    "-e",
    "OTEL_RESOURCE_ATTRIBUTES=host.name=forged-host,process.pid=999999,service.instance.id=forged-instance",
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
  const generations = [];
  for (const [index, stopSignal] of ["SIGTERM", "SIGINT"].entries()) {
    if (index) await docker(["start", gateway]);
    const gatewayURL = await containerURL(docker, gateway);
    await ready(gatewayURL, signal);
    const [container] = JSON.parse(await docker(["inspect", gateway]));
    assert.equal(container.Path, "/usr/local/bin/edge-gateway");
    assert.equal(container.Image, expectedImage.trim());
    assert(container.State.Pid > 0);
    const traceIDs = [];
    const receives = [];
    for (const path of routes) {
      const response = await fetch(`${gatewayURL}${path}`, {
        signal,
        headers: {
          Cookie: "__Host-antnest_session=fixture-token",
          Accept: "text/event-stream",
        },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        const diagnostic = await fetch(`${backendURL}/test/state`, { signal });
        const state = await diagnostic.text();
        throw new Error(
          `stream did not open: ${path} status=${response.status} upstream=${state}`,
        );
      }
      const traceID = response.headers.get("x-antnest-trace-id");
      assert.match(traceID ?? "", /^[a-f0-9]{32}$/u);
      assert(!traceIDs.includes(traceID));
      traceIDs.push(traceID);
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
    const instances = [];
    for (const traceID of traceIDs)
      instances.push(
        await processIdentity(
          collectorURL,
          traceID,
          container.Config.Hostname,
          traceOutput,
          signal,
        ),
      );
    assert.equal(new Set(instances).size, 1);
    const generation = {
      container_id: container.Id,
      host: container.Config.Hostname,
      started_at: container.State.StartedAt,
      instance: instances[0],
      trace_ids: traceIDs,
    };
    if (index) {
      assert.equal(generation.container_id, generations[0].container_id);
      assert.equal(generation.host, generations[0].host);
      assert.notEqual(generation.started_at, generations[0].started_at);
      assert.notEqual(generation.instance, generations[0].instance);
    }
    generations.push(generation);
  }
  return {
    image,
    signals: ["SIGTERM", "SIGINT"],
    restart: "passed",
    receiveRoutes: routes.length,
    receiveFamilies: ["workspace-bridge-events", "admin-agent-watch"],
    upstreamCancellations: routes.length * 2,
    exitCodes: [0, 0],
    processGenerations: generations,
  };
}

export async function run({
  root = fileURLToPath(new URL("../../../", import.meta.url)),
  project = `antnest-gateway-stop-${randomUUID().slice(0, 8)}`,
} = {}) {
  const { dockerClient } = await import("../lifecycle-closeout/docker.mjs");
  const { shutdownInterruption } = await import("./shutdown-interruption.mjs");
  const { evidenceDirectory } = await import("../../support/storage.mjs");
  assert.match(project, /^antnest-gateway-stop-[a-z0-9-]+$/u);
  const gatewayImage =
    process.env.ANTNEST_GATEWAY_TEST_IMAGE ??
    `antnest/gateway-shutdown:${project}`;
  const output = evidenceDirectory(
    resolve(root, "artifacts/verification/gateway-shutdown", project),
  );
  const credentials = evidenceDirectory(resolve(output, "credentials"));
  const traceOutput = evidenceDirectory(resolve(output, "traces"));
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
  writeFileSync(resolve(credentials, "csrf.key"), randomBytes(32), {
    mode: 0o600,
  });
  const lifecycle = shutdownInterruption();
  let failure, result;
  console.error(`Disposable Gateway shutdown project: ${project}`);
  try {
    if (!process.env.ANTNEST_GATEWAY_TEST_IMAGE)
      await dockerClient(
        process.env,
        lifecycle.signal,
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
      dockerClient(process.env, lifecycle.signal, 180000),
      lifecycle.signal,
      gatewayImage,
      credentials,
      traceOutput,
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
    lifecycle.beginCleanup();
    try {
      await cleanup(project, dockerClient(process.env, undefined, 60000));
    } catch (error) {
      failure = failure ? new AggregateError([failure, error]) : error;
    }
    try {
      rmSync(credentials, { recursive: true, force: true });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error]) : error;
    }
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
    failure = lifecycle.finish(failure);
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
else if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await run();
