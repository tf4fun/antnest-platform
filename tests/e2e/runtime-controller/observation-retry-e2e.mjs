import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  cleanup,
  composeArgs,
  configuration,
  dockerClient,
} from "../lifecycle-closeout/docker.mjs";
import { runCommand } from "../../support/run-command.mjs";
import { candidateCommand } from "../../support/candidate-images.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const api = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/runtime-controller/api/control-api.schema.json",
      import.meta.url,
    ),
  ),
);
const validateStatus = new Ajv2020({ strict: true }).compile(
  api.$defs.readiness,
);

function assertMonitorStatus(body, ready) {
  assert.deepEqual(body, {
    status: ready ? "ready" : "not_ready",
    live: true,
    ready,
    database_ready: true,
    platform_ready: true,
    observation_ready: true,
    monitor_ready: ready,
  });
}

const { values } = parseArgs({
  options: {
    output: {
      type: "string",
      default: "artifacts/verification/runtime-controller-observation-retry",
    },
  },
});
const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error("observation recovery verification interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 900000);
let config,
  imageTag,
  imageID,
  controllerID,
  failure,
  result,
  cleaned = false;

async function waitFor(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    if (await check()) return;
    await delay(200, undefined, { signal: abort.signal });
  }
  throw new Error(`${label} did not converge`);
}

async function removeCandidateImage(config, tag, id) {
  if (!tag) return;
  const docker = dockerClient(config.env, undefined, 60000);
  let image;
  try {
    [image] = JSON.parse(await docker(["image", "inspect", tag]));
  } catch (error) {
    if (id) throw error;
    return;
  }
  if (id) assert.equal(image.Id, id);
  assert.equal(image.Config.Labels["io.antnest.test-project"], config.project);
  await docker(["image", "rm", tag]);
}

try {
  config = await configuration(abort.signal);
  config.evidence = `${values.output}/${config.project}`;
  imageTag = `antnest/runtime-controller:observation-retry-${config.project.slice(-8)}`;
  Object.assign(config.env, {
    ANTNEST_RUNTIME_CONTROLLER_HOST_PORT: config.env.ANTNEST_EDGE_HOST_PORT,
    ANTNEST_OBSERVATION_PROXY_HOST_PORT:
      config.env.ANTNEST_LIFECYCLE_MODEL_HOST_PORT,
    ANTNEST_OBSERVATION_TEST_CONTROLLER_IMAGE: imageTag,
    ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY: "1s",
    ANTNEST_POSTGRES_ADMIN_PASSWORD: "observation-test-admin",
    ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: "",
    OTEL_SDK_DISABLED: "true",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
  });
  for (const role of [
    "EGRESS",
    "RUNTIME_CONTROLLER",
    "AGENT_ACP",
    "IDENTITY",
    "AGENT_CONTROLLER",
    "SKILL_REGISTRY",
    "TEMPORAL",
  ])
    config.env[`ANTNEST_${role}_POSTGRES_PASSWORD`] =
      "observation-test-database";
  config.compose = (args) =>
    composeArgs(config.project, [
      "-f",
      "tests/e2e/runtime-controller/observation-retry.compose.yaml",
      ...args,
    ]);
  const docker = dockerClient(config.env, abort.signal);
  console.log(`Disposable observation recovery project: ${config.project}`);
  const [, ...build] = candidateCommand({
    name: "runtime-controller",
    tag: imageTag,
    build: [
      "docker",
      "build",
      "--label",
      `io.antnest.test-project=${config.project}`,
      "-f",
      "services/runtime-controller/Dockerfile",
      "-t",
      imageTag,
      ".",
    ],
    labels: { "io.antnest.test-project": config.project },
  });
  await docker(build, true);
  imageID = await docker(["image", "inspect", "--format", "{{.Id}}", imageTag]);
  const rendered = JSON.parse(
    await docker(config.compose(["config", "--format", "json"])),
  );
  assert.equal(
    rendered.services["runtime-controller"].restart,
    "unless-stopped",
  );
  assert.equal(
    rendered.services["runtime-controller"].environment
      .ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY,
    "1s",
  );
  const started = await runCommand({
    name: "compose-up",
    command: [
      "docker",
      ...config.compose([
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "postgres",
        "runtime-egress",
        "runtime-controller",
        "diagnostic-relay",
      ]),
    ],
    output: config.evidence,
    env: config.env,
    timeoutMs: 600000,
  });
  assert.equal(
    started.exit_code,
    0,
    "Compose start failed; see private evidence",
  );
  controllerID = await docker(
    config.compose(["ps", "-q", "runtime-controller"]),
  );
  assert.match(controllerID, /^[a-f0-9]{64}$/);
  const state = async () =>
    JSON.parse(await docker(["inspect", controllerID]))[0];
  const logs = async () =>
    (await docker(["logs", controllerID]))
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  const initial = await state();
  assert.equal(initial.Image, imageID);
  assert.equal(initial.HostConfig.RestartPolicy.Name, "unless-stopped");
  function assertSameProcess(current) {
    assert.equal(current.State.Running, true);
    assert.equal(current.State.Restarting, false);
    assert.equal(
      current.RestartCount,
      0,
      "restart policy must not hide monitor process exits",
    );
    assert.equal(current.State.StartedAt, initial.State.StartedAt);
  }
  const controller = `http://127.0.0.1:${config.env.ANTNEST_RUNTIME_CONTROLLER_HOST_PORT}`;
  const proxy = `http://127.0.0.1:${config.env.ANTNEST_OBSERVATION_PROXY_HOST_PORT}`;
  const controllerToken = readFileSync(
    resolve(config.credentials, "agent-controller/tokens/runtime-controller"),
    "utf8",
  ).trim();
  // Readiness is served only to loopback callers, so a disposable probe joins
  // the controller's network namespace to read it.
  const readStatus = async () =>
    JSON.parse(
      await docker([
        "run",
        "--rm",
        "--pull",
        "never",
        "--label",
        `com.docker.compose.project=${config.project}`,
        "--network",
        `container:${controllerID}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "65532:65532",
        "node:24.21.0-bookworm-slim",
        "node",
        "-e",
        `fetch("http://127.0.0.1:8082/status", { signal: AbortSignal.timeout(5000) })
  .then(async (response) => console.log(JSON.stringify({ status: response.status, body: await response.text() })));`,
      ]),
    );
  const request = async (path, body, key, expectedStatus = 200) => {
    if (path === "/status") {
      const response = await readStatus();
      assert.equal(
        response.status,
        expectedStatus,
        `${path}: HTTP ${response.status}`,
      );
      const value = JSON.parse(response.body);
      assert(validateStatus(value), JSON.stringify(validateStatus.errors));
      return value;
    }
    const response = await fetch(controller + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Antnest-Service-Authorization": `Bearer ${controllerToken}`,
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
    });
    assert.equal(
      response.status,
      expectedStatus,
      `${path}: HTTP ${response.status}`,
    );
    return response.json();
  };
  const proxyMode = async (mode) => {
    const response = await fetch(`${proxy}/${mode}`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const monitorReady = async () =>
    Number(
      await docker(
        config.compose([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "antnest_test_admin",
          "-d",
          "antnest_runtime_controller",
          "-At",
          "-c",
          `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = ${0x414e5402} AND objid = 2 AND objsubid = 2 AND granted`,
        ]),
      ),
    ) > 0;
  await waitFor(async () => {
    assertSameProcess(await state());
    return (
      (await logs()).filter(
        (line) => line.error_class === "observation_reconcile_failed",
      ).length >= 2
    );
  }, "initial reconciliation retry");
  assert.equal(await monitorReady(), false);
  await assert.rejects(
    docker([
      "exec",
      controllerID,
      "/usr/local/bin/runtime-controller",
      "--healthcheck",
    ]),
  );
  const startupFailures = await logs();
  await proxyMode("online");
  await waitFor(async () => {
    try {
      return (
        (await request("/status")).status === "ready" && (await monitorReady())
      );
    } catch {
      return false;
    }
  }, "startup recovery");
  assertMonitorStatus(await request("/status"), true);
  assertSameProcess(await state());

  await proxyMode("offline");
  await waitFor(async () => {
    assertSameProcess(await state());
    return (
      !(await monitorReady()) &&
      (await logs()).some(
        (line) => line.error_class === "platform_reconciliation_failed",
      )
    );
  }, "Watch disconnect reconciliation");
  assertMonitorStatus(
    await request("/status", undefined, undefined, 503),
    false,
  );
  await assert.rejects(
    docker([
      "exec",
      controllerID,
      "/usr/local/bin/runtime-controller",
      "--healthcheck",
    ]),
  );
  await proxyMode("online");
  await waitFor(async () => {
    try {
      return (await request("/status")).monitor_ready && (await monitorReady());
    } catch {
      return false;
    }
  }, "HTTP and Watch recovery");
  assertMonitorStatus(await request("/status"), true);
  assertSameProcess(await state());

  const agent = `agent_${config.project.slice(-8).padEnd(32, "0")}`;
  const egress = `${config.project}-runtime-egress-1`;
  await waitFor(async () => {
    const [current] = JSON.parse(await docker(["inspect", egress]));
    return current.State.Health.Status === "healthy";
  }, "Egress readiness");
  // A disposable probe on the control network keeps Agent Controller's Egress
  // credential out of process arguments.
  const network = JSON.parse(
    await docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--label",
      `com.docker.compose.project=${config.project}`,
      "--network",
      `${config.project}_control`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,src=${resolve(config.credentials, "agent-controller/tokens/runtime-egress")},dst=/proof/token,readonly`,
      "node:24.21.0-bookworm-slim",
      "node",
      "-e",
      `const token = require("node:fs").readFileSync("/proof/token", "utf8").trim();
fetch(process.argv[1], { method: "PUT", headers: { "Antnest-Service-Authorization": "Bearer " + token }, signal: AbortSignal.timeout(10000) })
  .then(async (response) => { const body = await response.text(); if (!response.ok) throw new Error("Egress attachment failed: HTTP " + response.status); console.log(body); });`,
      `http://${config.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081/internal/agent-networks/${agent}`,
    ]),
  );
  const created = await request(
    `/internal/runtimes/${agent}/initialize`,
    {
      configuration: {
        image_ref: config.image,
        network: {
          packet_contract_revision: network.packet_contract_revision,
          egress_endpoint: network.egress_endpoint,
          tunnel_ipv4: network.tunnel_ipv4,
          resolver_ipv4: network.resolver_ipv4,
        },
        resources: {
          memory_bytes: 536870912,
          pids_limit: 256,
          tmpfs_bytes: 67108864,
        },
      },
    },
    `initialize-${agent}`,
  );
  assert.equal(created.state, "completed");
  assert.equal(created.inspection.lifecycle_state, "provisioned");
  const runtime = JSON.parse(
    await docker(["inspect", `antnest-runtime-${agent}`]),
  )[0];
  assert.equal(runtime.State.Running, true);
  const observations = await request(
    "/internal/runtime-observations?after_sequence=0&limit=100",
  );
  assert(
    observations.observations.filter((value) => value.kind === "reconciled")
      .length >= 2,
  );
  await proxyMode("disconnect-watch");
  await waitFor(async () => {
    try {
      const status = await request("/status", undefined, undefined, 503);
      return !status.monitor_ready && !(await monitorReady());
    } catch {
      return false;
    }
  }, "Watch-only disconnect readiness");
  assertMonitorStatus(
    await request("/status", undefined, undefined, 503),
    false,
  );
  assertSameProcess(await state());
  const deleted = await request(
    `/internal/runtimes/${agent}/delete`,
    { expected_revision: created.target_revision },
    `delete-${agent}`,
  );
  assert.equal(deleted.state, "completed");
  assert.equal(deleted.inspection.lifecycle_state, "deleted");
  assertMonitorStatus(
    await request("/status", undefined, undefined, 503),
    false,
  );
  await proxyMode("resume-watch");
  await waitFor(async () => {
    try {
      return (await request("/status")).monitor_ready && (await monitorReady());
    } catch {
      return false;
    }
  }, "Watch-only HTTP recovery");
  assertMonitorStatus(await request("/status"), true);
  assertSameProcess(await state());
  writeEvidenceFile(
    config.evidence,
    "startup-retries.private.json",
    JSON.stringify(startupFailures),
  );
  writeEvidenceFile(
    config.evidence,
    "recovery.private.json",
    JSON.stringify({ logs: await logs(), observations, created, deleted }),
  );
  result = {
    project: config.project,
    image_id: imageID,
    initial_failures: startupFailures.filter(
      (line) => line.error_class === "observation_reconcile_failed",
    ).length,
    restart_count: 0,
    startup_recovered: true,
    watch_recovered: true,
    monitor_readiness_recovered: true,
    watch_only_lifecycle_succeeded: true,
    runtime_created: true,
  };
} catch (error) {
  failure = error;
  if (config && controllerID) {
    try {
      const docker = dockerClient(config.env, undefined, 60000);
      writeEvidenceFile(
        config.evidence,
        "failure-logs.private.txt",
        await docker(["logs", controllerID]),
      );
    } catch {
      /* Preserve the original failure and still clean up. */
    }
  }
} finally {
  clearTimeout(timer);
  if (config) {
    try {
      await cleanup(config);
      await removeCandidateImage(config, imageTag, imageID);
      cleaned = true;
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "verification and cleanup failed",
          )
        : error;
    }
    writeEvidenceFile(
      config.evidence,
      "result.json",
      JSON.stringify({
        ...result,
        status: failure ? "failed" : "passed",
        cleanup: cleaned,
        ...(failure ? { error: failure.message } : {}),
      }),
    );
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (failure) {
  console.error(`Observation recovery E2E failed: ${failure.message}`);
  process.exitCode = 1;
} else console.log(JSON.stringify({ ...result, cleanup: cleaned }));
