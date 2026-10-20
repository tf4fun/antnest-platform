import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { runCommand } from "../../support/run-command.mjs";
import { workspaceManifestCommand } from "../../support/verification/workspace-manifest.mjs";
import {
  dockerClient,
  cleanup,
  composeArgs,
  lines,
} from "../lifecycle-closeout/docker.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";
import {
  developmentConfiguration,
  developmentEndpoint,
  developmentPrivateAccess,
  runDevelopmentFlow,
  resumeDevelopmentController,
} from "./deployment.mjs";
import { assertDevelopmentAcceptance } from "./deployed-evidence.mjs";
import { runDevelopmentRejection } from "./rejection.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
process.chdir(root);
process.umask(0o077);
const output = evidenceDirectory(
  `artifacts/verification/development-deployed-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const abort = new AbortController(),
  signal = abort.signal;
const interrupt = () =>
  abort.abort(new Error("Development deployment interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  status: "running",
  provider_scope: "controlled",
  commands: [],
  runtimes: [],
  workspace: {},
  evidence: output,
};
const save = (name, value) => {
  writeEvidenceFile(
    output,
    name,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
  );
  return join(output, name);
};
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
let docker,
  privateAccess,
  envFile,
  secretFile,
  database,
  admin,
  login,
  runtimeController;
const command = async (config, name, script, args = []) => {
  signal.throwIfAborted();
  const result = await runCommand({
    command: [process.execPath, script, ...args],
    cwd: root,
    env: config.env,
    output: join(output, "commands"),
    name,
    timeoutMs: 600000,
    graceMs: 30000,
  });
  assert.equal(result.complete, true, `${name}: child not joined`);
  assert.equal(result.exit_code, 0, `${name}: see private child log`);
  signal.throwIfAborted();
  return result;
};
async function driver(config, name, profile, inputs, basename) {
  const directory = join(output, name);
  const configuration = { ...inputs, output: directory };
  const configFile = save(`config-${name}.private.json`, configuration);
  const row = { name, profile, configuration: configFile, output: directory };
  report.commands.push(row);
  Object.assign(
    row,
    await command(config, name, `tests/e2e/development/${profile}.mjs`, [
      "--config",
      configFile,
    ]),
  );
  row.data = json(join(directory, basename));
  save("progress.private.json", report);
}
async function container(config, service) {
  const ids = lines(await docker(config.compose(["ps", "-a", "-q", service])));
  assert.equal(ids.length, 1, `${service}: one owned container required`);
  const [value] = JSON.parse(await docker(["inspect", ids[0]]));
  assert.equal(
    value.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(value.Config.Labels["com.docker.compose.service"], service);
  return value;
}
async function runtime(config, agentId) {
  assert.match(agentId, /^agent_[a-f0-9]+$/u);
  const rows = JSON.parse(
    await docker(["inspect", "antnest-runtime-" + agentId]),
  );
  assert.equal(rows.length, 1);
  const value = rows[0];
  assert.equal(value.Config.Labels["io.antnest.agent-id"], agentId);
  assert.equal(
    value.Config.Labels["io.antnest.runtime-controller-scope"],
    config.project,
  );
  assert.equal(value.Image, config.resolvedImage);
  assert.equal(value.State.Running, true);
  return value;
}
async function model(config) {
  const response = await fetch(config.model + "/status", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function rejection(config) {
  const directory = join(output, "rejection-private");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  report.rejection = await runDevelopmentRejection(config, {
    privateAccess,
    directory,
    agentId: report.browser.agent_id,
    browser: admin,
    principal: login.principal,
    signal,
    secrets: [
      config.env.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
      "stage3-model-secret",
      ...admin.cookies.values(),
    ],
  });
}
async function recoverySource(config) {
  const agentId = report.browser.agent_id;
  const readAgent = async () =>
    (await admin.request(`/api/admin/agents/${agentId}`)).body;
  const token = readFileSync(
    join(config.credentials, "agent-controller/tokens/runtime-controller"),
    "utf8",
  ).trim();
  report.runtime_reads = [];
  const inspectRuntime = async () => {
    const response = await fetch(
      `${runtimeController}/internal/runtimes/${agentId}`,
      {
        headers: { "Antnest-Service-Authorization": `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      },
    );
    const raw = await response.text();
    report.runtime_reads.push({ status: response.status, rawBody: raw });
    save("runtime-reads.private.json", report.runtime_reads);
    assert.equal(response.status, 200);
    return JSON.parse(raw);
  };
  const original = await runtime(config, agentId),
    controller = await container(config, "agent-controller"),
    before = await inspectRuntime();
  report.recovery_original = {
    agent: await readAgent(),
    runtime: original,
    controller,
    inspection: before,
  };
  assert.equal(before.health, "healthy");
  assert(before.runtime_execution_id);
  const manifest = save(
    "workspace-before-recovery.sha256",
    (await docker([
      "exec",
      original.Id,
      "sh",
      "-c",
      workspaceManifestCommand,
    ])) + "\n",
  );
  await docker(["stop", "-t", "15", controller.Id]);
  assert.equal(
    (await container(config, "agent-controller")).State.Running,
    false,
  );
  await docker(["restart", "-t", "15", original.Id]);
  const changed = await until(
    async () => {
      const value = await inspectRuntime();
      return (
        value.health === "healthy" &&
        value.phase === "running" &&
        value.runtime_execution_id &&
        value.runtime_execution_id !== before.runtime_execution_id &&
        value
      );
    },
    "restarted Runtime identity",
    signal,
  );
  assert.equal(changed.runtime_revision, before.runtime_revision);
  const restarted = await runtime(config, agentId);
  assert.equal(restarted.Id, original.Id);
  assert.notEqual(restarted.State.StartedAt, original.State.StartedAt);
  assert.deepEqual(restarted.Config.Labels, original.Config.Labels);
  assert.deepEqual(restarted.Mounts, original.Mounts);
  report.recovery_restart = { inspection: changed, runtime: restarted };
  const resumed = await resumeDevelopmentController(controller, {
    start: (id) => docker(["start", id]),
    inspectContainer: () => container(config, "agent-controller"),
    readAgent,
    signal,
  });
  report.recovery_controller = resumed.controller;
  report.recovery_source = resumed.agent;
  save("recovery-source.private.json", {
    original: report.recovery_original,
    restarted: report.recovery_restart,
    failed: report.recovery_source,
  });
  const mounts = original.Mounts.filter(
    (mount) => mount.Destination === "/workspace",
  );
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].Type, "volume");
  return {
    runtimeContainerPrefix: "antnest-runtime-",
    runtimeControllerScope: config.project,
    workspaceVolume: mounts[0].Name,
    workspaceManifest: manifest,
  };
}
const actions = {
  configure: (allocated) =>
    developmentConfiguration(signal, (project) =>
      allocated({ project, env: { ...process.env } }),
    ),
  async deploy(config) {
    docker = dockerClient(config.env, signal, 1800000);
    report.runtime_image = config.image;
    report.runtime_digest = config.resolvedImage;
    report.compose = JSON.parse(
      await docker(config.compose(["config", "--format", "json"])),
    );
    save("compose.private.json", report.compose);
    const tag = config.env.ANTNEST_ADMISSION_TAG;
    for (const service of [
      "runtime-egress",
      "runtime-controller",
      "agent-acp-service",
      "identity-service",
      "agent-controller",
      "skill-registry",
      "admin-console",
      "agent-ui",
      "edge-gateway",
      "temporal",
    ])
      assert.equal(
        report.compose.services[service].image,
        `antnest/${service}:${tag}`,
      );
    await docker(
      config.compose([
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-build",
        "--pull",
        "never",
      ]),
      true,
    );
    privateAccess = await developmentPrivateAccess(config, docker);
    runtimeController = await developmentEndpoint(
      config,
      docker,
      "diagnostic-relay",
      58080,
    );
    envFile = save(
      "environment.private.env",
      Object.entries(config.env)
        .filter(([key]) => /^(ANTNEST_|OTEL_)/u.test(key))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
    );
    secretFile = save(
      "provider.private.env",
      "DEEPSEEK_API_KEY=stage3-model-secret\n",
    );
    const postgres = await container(config, "postgres");
    database = {
      container: postgres.Id,
      user: "antnest_agent_acp",
      name: "antnest_agent_acp",
    };
    report.deployment = { privateAccess, runtimeController, postgres };
  },
  async browser(config) {
    const directory = join(output, "browser");
    report.browser_command = await command(
      config,
      "browser",
      "tests/e2e/workspace-closeout/development-browser.mjs",
      [
        "--confirm-development",
        "--gateway",
        config.gateway,
        "--jaeger",
        config.jaeger,
        "--env-file",
        envFile,
        "--secret-file",
        secretFile,
        "--output",
        directory,
        "--provider-scope",
        "controlled",
        "--provider-endpoint",
        "http://stage3-model:8080/v1",
        "--runtime-image",
        config.image,
      ],
    );
    report.browser = json(join(directory, "report.json"));
    const physical = await runtime(config, report.browser.agent_id);
    report.runtimes.push(physical);
    report.workspace.before = await docker([
      "exec",
      physical.Id,
      "cat",
      "/workspace/acceptance-note.txt",
    ]);
    report.model = await model(config);
    save("browser-complete.private.json", report);
  },
  async drivers(config) {
    const { agent_id: agentId, session_id: sessionId } = report.browser;
    const read = { gateway: config.gateway, envFile, agentId, privateAccess };
    const replay = { ...read, jaeger: config.jaeger, sessionId, database };
    const shared = {
      gateway: config.gateway,
      jaeger: config.jaeger,
      envFile,
      secretFile,
      retainedAgentId: agentId,
    };
    await driver(
      config,
      "state-before",
      "agent-state",
      read,
      "agent-state.json",
    );
    await driver(
      config,
      "replay-before",
      "replay",
      replay,
      "replay-report.json",
    );
    await driver(
      config,
      "chat-trace",
      "trace-review",
      {
        jaeger: config.jaeger,
        envFile,
        secretFile,
        sessionId,
        expectedTraceCount: 3,
        minRuntimeTraces: 2,
      },
      "trace-review-3.json",
    );
    admin = new GatewayClient(config.gateway);
    login = (
      await admin.request("/api/session/login", {
        body: {
          organization_slug: config.env.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
          email: config.env.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
          password: config.env.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
        },
      })
    ).body;
    save("driver-login.private.json", {
      principal: login.principal,
      cookie: admin.cookie,
    });
    await rejection(config);
    await driver(
      config,
      "rejection-trace",
      "rejection-trace",
      { jaeger: config.jaeger, rejectedSessionId: report.rejection.sessionId },
      "rejection-trace-review.json",
    );
    await driver(
      config,
      "lifecycle",
      "lifecycle",
      {
        ...shared,
        runtimeControllerScope: config.project,
        fixtureName: "Development lifecycle",
        workspaceFile: "/workspace/development-lifecycle.txt",
        workspaceMarker: "development-lifecycle-retained",
      },
      "lifecycle-report.json",
    );
    const restartSnapshot = save(
      "runtime-controller.private.json",
      await container(config, "runtime-controller"),
    );
    await driver(
      config,
      "runtime-loss",
      "runtime-loss",
      {
        ...shared,
        privateAccess,
        fixtureName: "Development Runtime loss",
        workspaceFile: "/workspace/development-loss.txt",
        workspaceMarker: "development-loss-retained",
        restartSnapshot,
        composeSnapshot: join(output, "compose.private.json"),
      },
      "lifecycle-report.json",
    );
    const recovery = await recoverySource(config);
    await driver(
      config,
      "recover",
      "recover",
      { ...shared, ...recovery, privateAccess },
      "recovery-report.json",
    );
    await driver(
      config,
      "state-after",
      "agent-state",
      read,
      "agent-state.json",
    );
    await driver(
      config,
      "replay-after",
      "replay",
      replay,
      "replay-report.json",
    );
    const physical = await runtime(config, agentId);
    report.runtimes.push(physical);
    report.workspace.after = await docker([
      "exec",
      physical.Id,
      "cat",
      "/workspace/acceptance-note.txt",
    ]);
    report.model = await model(config);
  },
  admit: () => assertDevelopmentAcceptance(report),
  async logs(config) {
    const observer = dockerClient(config.env, undefined, 60000);
    const errors = [];
    for (const [name, action] of [
      [
        "services.private.log",
        () =>
          observer(
            (config.compose ?? ((args) => composeArgs(config.project, args)))([
              "logs",
              "--no-color",
              "--tail",
              "500",
            ]),
          ),
      ],
      [
        "containers.private.json",
        async () => {
          const ids = lines(
            await observer([
              "ps",
              "-aq",
              "--filter",
              `label=com.docker.compose.project=${config.project}`,
            ]),
          );
          return ids.length
            ? JSON.parse(await observer(["inspect", ...ids]))
            : [];
        },
      ],
    ])
      try {
        save(name, await action());
      } catch (error) {
        errors.push(error);
      }
    if (errors.length)
      throw new AggregateError(errors, "Development diagnostics incomplete");
  },
  cleanup(config) {
    const credentials = resolve(
      root,
      "artifacts/verification/authenticated-e2e",
      config.project,
      "credentials",
    );
    return cleanup({
      ...config,
      ...(existsSync(credentials) ? { credentials } : {}),
    });
  },
  save: (value) => save("report.private.json", value),
};
console.error("Development deployed evidence: " + output);
try {
  await runDevelopmentFlow({ report, signal }, actions);
  process.exitCode = report.exit_code;
  console.log(
    JSON.stringify({
      status: report.status,
      project: report.project,
      stage: report.stage,
      provider_scope: report.provider_scope,
      commands: report.commands.length,
      cleanup: report.cleanup,
      evidence: output,
    }),
  );
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
