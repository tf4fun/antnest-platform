import assert from "node:assert/strict";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { setup, until } from "../workspace-closeout/c4-setup.mjs";
import { resolveObservationConfig } from "../observability/resolve-config.mjs";
import { certificates } from "./tls-certificates.mjs";
import { verifyResolveLoad } from "./resolve-cache-flow.mjs";
import { verifyWarmOutage } from "./resolve-cache-outage-flow.mjs";
import { cacheEvidencePaths } from "./resolve-cache-ownership.mjs";

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const abort = new AbortController();
const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(900000)]);
const interrupt = () =>
  abort.abort(new Error("HTTPS cache acceptance interrupted"));
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
const roots = getCACertificates("default"),
  ownerLabel = "io.antnest.verification.project";
const candidates = [],
  candidateIDs = new Map();
let before,
  config,
  output,
  certificateDirectory,
  credentialsDirectory,
  report,
  failure;
try {
  before = await snapshotEnvironment({
    signal,
    images: [
      "admin-console",
      "agent-acp-service",
      "agent-ui",
      "edge-gateway",
      "identity-service",
      "runtime-controller",
      "antnest-runtime",
    ].map((name) => `antnest/${name}:local`),
  });
  config = await configuration(signal, (project) => {
    ({ credentialsDirectory, output } = cacheEvidencePaths(
      project,
      process.env.ANTNEST_RESOLVE_CACHE_E2E_OUTPUT,
    ));
  });
  const save = (name, data) =>
    writeEvidenceFile(output, name, JSON.stringify(data, null, 2));
  save("environment-before.json", before);
  certificateDirectory = resolve(output, "private-tls");
  const certificate = certificates(certificateDirectory, {
    dnsNames: ["host.docker.internal"],
  });
  config.gateway = config.gateway.replace("http:", "https:");
  Object.assign(config.env, {
    ANTNEST_EDGE_PUBLIC_BASE_URL: config.gateway,
    ANTNEST_EDGE_TLS_DIRECTORY: certificateDirectory,
    ANTNEST_EDGE_TLS_HOST_PORT: config.env.ANTNEST_EDGE_HOST_PORT,
    ANTNEST_EDGE_TLS_BIND_ADDRESS: "127.0.0.1",
    ANTNEST_EDGE_RESOLVE_CACHE_TTL: "10s",
    ANTNEST_EDGE_REQUEST_TIMEOUT: "150s",
    ANTNEST_AGENT_CONTROLLER_EXECUTION_RESYNC_INTERVAL: "1s",
    ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
    ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
      config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
    ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
      config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(".0/24", ".128/25"),
  });
  const docker = dockerClient(config.env, signal, 900000);
  const compose = (args) =>
    composeArgs(config.project, [
      "-f",
      "tests/e2e/workspace-closeout/c4.compose.yaml",
      "-f",
      "tests/e2e/edge-gateway/security-headers.compose.yaml",
      "-f",
      "compose.tls.yaml",
      "-f",
      "tests/e2e/edge-gateway/tls.compose.yaml",
      "-f",
      "tests/e2e/edge-gateway/browser-sessions.compose.yaml",
      ...args,
    ]);
  for (const [service, variable] of [
    ["admin-console", "ANTNEST_TLS_E2E_CONSOLE_IMAGE"],
    ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
    ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
    ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
    ["identity-service", "ANTNEST_SECURITY_E2E_IDENTITY_IMAGE"],
    ["runtime-controller", "ANTNEST_SECURITY_E2E_RC_IMAGE"],
  ]) {
    const image = `antnest/${service}:resolve-cache-e2e-${config.project.slice(-8)}`;
    assert.equal(
      await docker(["image", "ls", "-q", "--filter", `reference=${image}`]),
      "",
    );
    config.env[variable] = image;
    candidates.push(image);
    console.log(JSON.stringify({ phase: "build", service }));
    const [, ...build] = candidateCommand({
      name: service,
      tag: image,
      build: [
        "docker",
        "build",
        "-f",
        `services/${service}/Dockerfile`,
        "--label",
        `${ownerLabel}=${config.project}`,
        "-t",
        image,
        ".",
      ],
      labels: { [ownerLabel]: config.project },
    });
    await docker(build, true, { env: candidateEnvironment(config.env) });
    const [row] = JSON.parse(await docker(["image", "inspect", image]));
    assert.equal(row.Config.Labels[ownerLabel], config.project);
    candidateIDs.set(image, row.Id);
  }
  save("candidate-images.json", Object.fromEntries(candidateIDs));
  console.log(JSON.stringify({ phase: "start", project: config.project }));
  await docker(
    compose(["up", "-d", "--wait", "--wait-timeout", "180", "--no-build"]),
    true,
  );
  const gatewayID = await docker(compose(["ps", "-q", "edge-gateway"]));
  const [gateway] = JSON.parse(await docker(["inspect", gatewayID]));
  assert.deepEqual(gateway.HostConfig.PortBindings ?? {}, {});
  const actual = Object.fromEntries(
    gateway.Config.Env.map((value) => {
      const split = value.indexOf("=");
      return [value.slice(0, split), value.slice(split + 1)];
    }),
  );
  const settings = resolveObservationConfig(actual, {});
  assert.equal(settings.resolveTTLMS, 10000);
  assert.equal(settings.captureRpcContent, false);
  assert.equal(actual.OTEL_SDK_DISABLED, "false");
  assert.equal(actual.OTEL_TRACES_EXPORTER, "otlp");
  assert.equal(actual.ANTNEST_EDGE_REQUEST_TIMEOUT, "150s");
  const controllerID = await docker(compose(["ps", "-q", "agent-controller"]));
  const [controller] = JSON.parse(await docker(["inspect", controllerID]));
  assert.equal(
    controller.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(
    controller.Config.Labels["com.docker.compose.service"],
    "agent-controller",
  );
  assert(
    controller.Config.Env.includes(
      "ANTNEST_AGENT_CONTROLLER_EXECUTION_RESYNC_INTERVAL=1s",
    ),
  );
  const deployment = {
    gateway_image: gateway.Image,
    gateway_container: gateway.Id,
    ...settings,
    request_timeout_ms: 150000,
    telemetry_disabled: actual.OTEL_SDK_DISABLED,
    traces_exporter: actual.OTEL_TRACES_EXPORTER,
    controller_container: controllerID,
    execution_resync_interval: "1s",
  };
  save("setup-deployment.json", deployment);
  setDefaultCACertificates([...roots, certificate.ca]);
  await until(
    async () => {
      try {
        const response = await fetch(`${config.gateway}/status`, {
          signal: AbortSignal.timeout(2000),
        });
        await response.arrayBuffer();
        return response.status === 200;
      } catch {
        return false;
      }
    },
    "public HTTPS ready",
    signal,
    30000,
  );
  const fixture = await setup(config, signal);
  // Provisioning keeps its normal budget. Recreate only the owned Gateway
  // after setup and before any load/warm-cache observations. The short request
  // budget lets real negative HTTP responses complete inside the 5s stop.
  config.env.ANTNEST_EDGE_REQUEST_TIMEOUT = "2s";
  await docker(
    compose([
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "30",
      "--no-build",
      "edge-gateway",
    ]),
  );
  const observedID = await docker(compose(["ps", "-q", "edge-gateway"]));
  assert.match(observedID, /^[a-f0-9]{64}$/u);
  assert.notEqual(observedID, gatewayID);
  const [observed] = JSON.parse(await docker(["inspect", observedID]));
  assert.equal(
    observed.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(
    observed.Config.Labels["com.docker.compose.service"],
    "edge-gateway",
  );
  assert.equal(observed.State.Running, true);
  assert.equal(observed.State.Health.Status, "healthy");
  assert.equal(observed.Image, gateway.Image);
  assert.deepEqual(observed.HostConfig.PortBindings ?? {}, {});
  const observedEnv = Object.fromEntries(
    observed.Config.Env.map((value) => {
      const split = value.indexOf("=");
      return [value.slice(0, split), value.slice(split + 1)];
    }),
  );
  assert.equal(observedEnv.ANTNEST_EDGE_REQUEST_TIMEOUT, "2s");
  assert.deepEqual(resolveObservationConfig(observedEnv, {}), settings);
  assert.equal(observedEnv.OTEL_SDK_DISABLED, "false");
  assert.equal(observedEnv.OTEL_TRACES_EXPORTER, "otlp");
  save("deployment.json", {
    ...deployment,
    gateway_container: observedID,
    request_timeout_ms: 2000,
    setup_gateway_container: gatewayID,
  });
  console.log(JSON.stringify({ phase: "verify", check: "100-acp-load" }));
  const load = await verifyResolveLoad({
    config,
    fixture,
    settings,
    signal,
    output,
  });
  console.log(
    JSON.stringify({ phase: "verify", check: "identity-warm-outage" }),
  );
  const outage = await verifyWarmOutage({
    config,
    fixture,
    settings,
    signal,
    output,
    docker,
    compose,
    requestTimeoutMS: 2000,
  });
  report = {
    status: "business_passed",
    scenarios: 1,
    verified: ["100-acp-load"],
    pending: ["identity-outage-recovery"],
    traces: [load, ...outage.trace_evidence.reports],
    warm_outage: {
      ...outage,
      trace_evidence: { ...outage.trace_evidence, reports: undefined },
    },
    strict_trace:
      load.strict_trace === "failed" ||
      outage.trace_evidence.strict_trace === "failed"
        ? "failed"
        : "passed",
  };
  save("report.json", report);
} catch (error) {
  failure = error;
  if (output)
    writeEvidenceFile(
      output,
      "failure.private.txt",
      error.stack ?? String(error),
    );
} finally {
  const errors = [];
  const attempt = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push(error);
    }
  };
  if (config) {
    const docker = dockerClient(config.env, undefined, 180000);
    if (failure)
      await attempt(async () => {
        const logs = await docker(
          composeArgs(config.project, ["logs", "--no-color"]),
        );
        writeEvidenceFile(output, "services.private.log", logs);
      });
    await attempt(() => cleanup(config));
    for (const image of candidates)
      await attempt(async () => {
        if (
          !(await docker([
            "image",
            "ls",
            "-q",
            "--filter",
            `reference=${image}`,
          ]))
        )
          return;
        const [row] = JSON.parse(await docker(["image", "inspect", image]));
        assert.equal(row.Config.Labels[ownerLabel], config.project);
        if (candidateIDs.has(image))
          assert.equal(row.Id, candidateIDs.get(image));
        await docker(["image", "rm", image]);
      });
  }
  setDefaultCACertificates(roots);
  if (credentialsDirectory)
    await attempt(async () =>
      rmSync(credentialsDirectory, { recursive: true, force: true }),
    );
  if (certificateDirectory)
    await attempt(async () =>
      rmSync(certificateDirectory, { recursive: true, force: true }),
    );
  if (before)
    await attempt(async () => {
      const after = await snapshotEnvironment({ before });
      const comparison = compareEnvironment(before, after);
      if (output) {
        writeEvidenceFile(
          output,
          "environment-after.json",
          JSON.stringify(after, null, 2),
        );
        writeEvidenceFile(
          output,
          "cleanup.json",
          JSON.stringify(comparison, null, 2),
        );
      }
      assert.equal(comparison.unchanged, true, JSON.stringify(comparison));
    });
  for (const event of ["SIGINT", "SIGTERM"]) process.off(event, interrupt);
  if (failure || errors.length) {
    if (output && errors.length)
      writeEvidenceFile(
        output,
        "cleanup-errors.private.txt",
        errors.map((error) => error.stack ?? String(error)).join("\n"),
      );
    console.log(
      JSON.stringify({
        status: "business_failed",
        evidence: output,
        cleanup: errors.length ? "failed" : "verified",
      }),
    );
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ...report, cleanup: "verified" }));
    process.exitCode = report.strict_trace === "failed" ? 2 : 0;
  }
}
