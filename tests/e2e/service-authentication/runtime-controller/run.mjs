import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "../../../support/run-command.mjs";
import {
  dockerClient,
  networkOctet,
  owned,
  scopeLabel,
} from "../../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const project = "antnest-rc-auth-" + randomUUID();
const evidence = resolve(
  root,
  "artifacts/verification/runtime-controller-authentication",
  project,
);
const directory = resolve(evidence, "credentials");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const keys = Object.fromEntries(
  ["current", "next", "wrong"].map((name) => [
    name,
    randomBytes(32).toString("base64url"),
  ]),
);
writeFileSync(resolve(directory, "fixture.json"), JSON.stringify(keys), {
  mode: 0o600,
});
const saveCallers = (tokens) => {
  const body = {
    "agent-controller": tokens.map(
      (token) => "sha256:" + createHash("sha256").update(token).digest("hex"),
    ),
    "skill-registry": [
      "sha256:" + createHash("sha256").update(keys.wrong).digest("hex"),
    ],
  };
  writeFileSync(resolve(directory, "callers.next.json"), JSON.stringify(body), {
    mode: 0o600,
  });
  renameSync(
    resolve(directory, "callers.next.json"),
    resolve(directory, "callers.json"),
  );
};
saveCallers([keys.current, keys.next]);
writeFileSync(
  resolve(directory, "runtime-egress"),
  randomBytes(32).toString("base64url"),
  { mode: 0o600 },
);
writeFileSync(resolve(directory, "instance-master"), randomBytes(32), {
  mode: 0o600,
});
const abort = new AbortController();
const stop = () => abort.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
const timer = setTimeout(stop, 600000);
const docker = dockerClient(process.env, abort.signal, 600000);
let env,
  compose,
  image,
  runtimeImage,
  checks = 0,
  complete = false,
  cleaned = false;
try {
  const octet = await networkOctet(docker, 1 + (process.pid % 200));
  image = project + ":candidate";
  env = {
    ...process.env,
    RC_AUTH_IMAGE: image,
    RC_AUTH_SCOPE: project,
    RC_AUTH_DIRECTORY: directory,
    RC_AUTH_DATABASE_PASSWORD: randomBytes(32).toString("hex"),
    RC_AUTH_CONTROL_SUBNET: `10.242.${octet}.0/24`,
    RC_AUTH_CONTROL_IP: `10.242.${octet}.10`,
    RC_AUTH_MANAGEMENT_SUBNET: `10.243.${octet}.0/24`,
    RC_AUTH_READINESS_IP: `10.243.${octet}.3`,
    RC_AUTH_MANAGEMENT_NETWORK: project + "-management",
    RC_AUTH_SYSTEM_SKILLS_VOLUME: project + "-system-skills",
  };
  compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "--project-name",
    project,
    "-f",
    resolve(
      root,
      "tests/e2e/service-authentication/runtime-controller/compose.yaml",
    ),
  ];
  const invoke = dockerClient(env, abort.signal, 600000);
  runtimeImage = "antnest/antnest-runtime:rc-instance-" + project.slice(-8);
  await invoke(
    [
      "build",
      "-f",
      resolve(
        root,
        "tests/e2e/service-authentication/runtime-controller/runtime-fixture.Dockerfile",
      ),
      "-t",
      runtimeImage,
      root,
    ],
    true,
  );
  await invoke(
    [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "180"],
    true,
  );
  const id = await invoke([...compose, "ps", "-q", "runtime-controller"]);
  const [container] = JSON.parse(await invoke(["inspect", id]));
  assert.deepEqual(container.NetworkSettings.Ports, {});
  assert.equal(
    container.NetworkSettings.Networks[project + "_control"].IPAddress,
    env.RC_AUTH_CONTROL_IP,
  );
  assert(container.NetworkSettings.Networks[env.RC_AUTH_MANAGEMENT_NETWORK]);
  checks++;
  let privateProbe = 0;
  const probe = async (service, mode, options = {}) => {
    const args = [
      ...compose,
      "exec",
      "-T",
      service,
      "node",
      "/fixture/probe.mjs",
      mode,
      JSON.stringify(options),
    ];
    if (mode !== "instance") return JSON.parse(await invoke(args));
    const name = "instance-probe-" + privateProbe++;
    const result = await runCommand({
      name,
      command: ["docker", ...args],
      cwd: root,
      env,
      output: evidence,
      timeoutMs: 30000,
      graceMs: 5000,
    });
    assert.equal(result.exit_code, 0, name + " failed; see private evidence");
    return JSON.parse(readFileSync(resolve(evidence, name + ".log"), "utf8"));
  };
  checks += (await probe("control-probe", "matrix")).checks;
  checks += (await probe("management-probe", "unreachable")).checks;
  const request = async (options) => {
    const result = await probe("control-probe", "request", options);
    checks++;
    return result;
  };
  const installed = await invoke([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    runtimeImage,
  ]);
  const resolution = await request({
    path:
      "/internal/runtime-images/resolve?reference=" +
      encodeURIComponent(runtimeImage),
  });
  assert.equal(resolution.image_ref, installed);
  checks++;
  for (const reference of [
    "alpine:latest",
    "evil.example/antnest/antnest-runtime:local",
    "antnest/antnest-runtime-spoof:local",
    installed,
  ])
    await request({
      path:
        "/internal/runtime-images/resolve?reference=" +
        encodeURIComponent(reference),
      status: 422,
      code: "image_not_allowed",
    });
  const configuration = {
    image_ref: runtimeImage,
    network: {
      packet_contract_revision: 2,
      egress_endpoint: { ipv4: `10.243.${octet}.3`, port: 8092 },
      tunnel_ipv4: "100.64.0.2",
      resolver_ipv4: "100.64.0.1",
    },
    resources: {
      memory_bytes: 536870912,
      pids_limit: 256,
      tmpfs_bytes: 67108864,
    },
  };
  const mutate = (agent, action, body, key, extra = {}) =>
    request({
      method: "POST",
      path: `/internal/runtimes/${agent}/${action}`,
      body,
      headers: { "Idempotency-Key": key },
      ...extra,
    });
  await mutate(
    "disallowed",
    "initialize",
    { configuration: { ...configuration, image_ref: "alpine:latest" } },
    "disallowed-create",
    { status: 422, code: "image_not_allowed" },
  );
  await request({
    path: "/internal/runtime-operations/disallowed-create",
    status: 404,
    code: "operation_not_found",
  });
  assert.equal(
    await invoke([
      "ps",
      "-aq",
      "--filter",
      "label=" + scopeLabel + "=" + project,
    ]),
    "",
  );
  checks++;
  const agent = "rc-auth-" + project.slice(-8);
  writeFileSync(resolve(directory, "registration-unavailable"), "", {
    mode: 0o600,
  });
  const outageAgent = agent + "-outage";
  await mutate(
    outageAgent,
    "initialize",
    { configuration },
    "registration-outage",
    { status: 503, code: "tunnel_registration_unavailable" },
  );
  const waiting = await request({
    path: "/internal/runtime-operations/registration-outage",
  });
  assert.equal(waiting.state, "running");
  assert.equal(
    await invoke([
      "ps",
      "-aq",
      "--filter",
      `label=${scopeLabel}=${project}`,
      "--filter",
      "label=io.antnest.managed=runtime",
    ]),
    "",
  );
  rmSync(resolve(directory, "registration-unavailable"));
  const recovered = await mutate(
    outageAgent,
    "initialize",
    { configuration },
    "registration-outage",
  );
  assert.equal(recovered.state, "completed");
  await mutate(
    outageAgent,
    "delete",
    { expected_revision: recovered.target_revision },
    "registration-outage-delete",
  );
  checks += 3;
  const initialized = await mutate(
    agent,
    "initialize",
    { configuration },
    "initialize",
  );
  assert.equal(initialized.state, "completed");
  assert.equal(initialized.inspection.lifecycle_state, "provisioned");
  let revision = initialized.target_revision;
  const list = await request({ path: "/internal/runtimes" });
  assert.equal(list.runtimes.length, 1);
  const runtimeIDs = (
    await invoke([
      "ps",
      "-aq",
      "--filter",
      `label=${scopeLabel}=${project}`,
      "--filter",
      "label=io.antnest.managed=runtime",
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  const rows = JSON.parse(await invoke(["inspect", ...runtimeIDs]));
  const runtime = rows.find((row) => row.Id !== id);
  assert(runtime, "lifecycle did not create a managed Runtime");
  const managementIPv4 =
    runtime.NetworkSettings.Networks[env.RC_AUTH_MANAGEMENT_NETWORK].IPAddress;
  assert.equal(list.runtimes[0].runtime_endpoint, managementIPv4);
  const peerInspection = await request({ path: `/internal/runtimes/${agent}` });
  assert.equal(peerInspection.runtime_endpoint, managementIPv4);
  assert.equal(peerInspection.runtime_revision, revision);
  assert.equal(
    peerInspection.tunnel_key_id,
    JSON.parse(
      runtime.Config.Env.find((value) =>
        value.startsWith("ANTNEST_RUNTIME_SPEC="),
      ).slice("ANTNEST_RUNTIME_SPEC=".length),
    ).authentication.tunnel.key_id,
  );
  checks += 3;
  assert.equal(
    runtime.Config.Image,
    installed,
    "container did not use the frozen image identity",
  );
  checks++;
  await mutate(
    agent,
    "update",
    {
      expected_revision: revision,
      configuration: { ...configuration, image_ref: "alpine:latest" },
    },
    "disallowed-update",
    { status: 422, code: "image_not_allowed" },
  );
  await request({
    path: "/internal/runtime-operations/disallowed-update",
    status: 404,
    code: "operation_not_found",
  });
  assert.equal(
    (await request({ path: `/internal/runtimes/${agent}` })).runtime_revision,
    revision,
  );
  const waitHealthy = async () => {
    const deadline = Date.now() + 60000;
    for (;;) {
      abort.signal.throwIfAborted();
      try {
        await invoke([
          ...compose,
          "exec",
          "-T",
          "runtime-controller",
          "/usr/local/bin/runtime-controller",
          "--healthcheck",
        ]);
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(500, undefined, { signal: abort.signal });
      }
    }
  };
  const waitRuntime = async (runtimeAgent = agent) => {
    const deadline = Date.now() + 60000;
    for (;;) {
      const current = await request({
        path: `/internal/runtimes/${runtimeAgent}`,
        auth: "next",
      });
      if (current.health === "healthy" && current.runtime_execution_id)
        return current;
      if (Date.now() > deadline)
        throw new Error("owned fixture Runtime did not become verified");
      await delay(250, undefined, { signal: abort.signal });
    }
  };
  assert.equal((await waitRuntime()).runtime_endpoint, managementIPv4);
  checks++;
  // A real disconnected container is an individual unbindable observation,
  // while both logical List and the monitor remain usable for a healthy peer.
  const healthyAgent = agent + "-peer-proof";
  const healthyCreated = await mutate(
    healthyAgent,
    "initialize",
    { configuration },
    "peer-proof-initialize",
  );
  const healthyRuntime = await waitRuntime(healthyAgent);
  await invoke([
    "network",
    "disconnect",
    env.RC_AUTH_MANAGEMENT_NETWORK,
    runtime.Id,
  ]);
  try {
    const disconnected = await request({ path: `/internal/runtimes/${agent}` });
    assert.equal(disconnected.phase, "running");
    assert.equal(disconnected.health, "unknown");
    assert.equal(disconnected.reason, "runtime_peer_unavailable");
    assert.equal(disconnected.runtime_endpoint ?? null, null);
    assert.equal(disconnected.runtime_execution_id ?? "", "");
    const inventory = await request({ path: "/internal/runtimes" });
    const unaffected = inventory.runtimes.find(
      (value) => value.agent_id === healthyAgent,
    );
    assert.equal(unaffected.health, "healthy");
    assert.equal(unaffected.runtime_endpoint, healthyRuntime.runtime_endpoint);
    await waitHealthy();
    checks += 7;
  } finally {
    await invoke([
      "network",
      "connect",
      "--ip",
      managementIPv4,
      env.RC_AUTH_MANAGEMENT_NETWORK,
      runtime.Id,
    ]);
  }
  await waitRuntime();
  await mutate(
    healthyAgent,
    "delete",
    { expected_revision: healthyCreated.target_revision },
    "peer-proof-delete",
  );
  const beforeConnection = await probe("instance-probe", "instance", { agent });
  checks += beforeConnection.checks;
  const authMount = runtime.Mounts.find(
    (mount) => mount.Destination === "/run/antnest-auth",
  );
  assert(authMount && !authMount.RW);
  const [authVolume] = JSON.parse(
    await invoke(["volume", "inspect", authMount.Name]),
  );
  assert.equal(
    authVolume.Labels["io.antnest.runtime-controller-scope"],
    project,
  );
  const rawBootstrap = await invoke([
    "exec",
    runtime.Id,
    "cat",
    "/run/antnest-auth/callers.json",
  ]);
  const receiver = JSON.parse(rawBootstrap);
  assert.deepEqual(Object.keys(receiver).sort(), [
    "agent-acp-service",
    "runtime-controller",
  ]);
  assert.deepEqual(receiver["agent-acp-service"], [
    "sha256:" + beforeConnection.token_digest,
  ]);
  assert.notEqual(
    receiver["runtime-controller"][0],
    receiver["agent-acp-service"][0],
  );
  const uidRead = await invoke([
    "exec",
    "--user",
    "1000:1000",
    runtime.Id,
    "node",
    "-e",
    "for (const file of ['callers.json','tunnel.json']) { try { require('fs').readFileSync('/run/antnest-auth/'+file); process.exit(1); } catch(e) { if(e.code !== 'EACCES') process.exit(2); } }",
  ]);
  assert.equal(uidRead, "");
  checks += 3;
  saveCallers([keys.next]);
  await request({ auth: "current" }); // Receiver changes require restart.
  await invoke([...compose, "restart", "runtime-controller"], true);
  await waitHealthy();
  await request({
    auth: "current",
    status: 401,
    code: "service_unauthenticated",
  });
  await request({ auth: "next" });
  const afterConnection = await probe("instance-probe", "instance", {
    agent,
    auth: "next",
  });
  assert.equal(afterConnection.connection_id, beforeConnection.connection_id);
  assert.equal(afterConnection.token_digest, beforeConnection.token_digest);
  checks += afterConnection.checks + 2;
  const replay = await request({
    method: "POST",
    path: `/internal/runtimes/${agent}/initialize`,
    body: { configuration },
    headers: { "Idempotency-Key": "initialize" },
    auth: "next",
  });
  assert.equal(replay.target_revision, revision);
  checks++;
  // Remaining mutations use the surviving Controller credential.
  const lifecycle = async (action, body) => {
    const result = await mutate(agent, action, body, action, { auth: "next" });
    assert.equal(result.state, "completed");
    revision = result.target_revision;
    return result;
  };
  await lifecycle("update", { expected_revision: revision, configuration });
  await waitRuntime();
  const updatedConnection = await probe("instance-probe", "instance", {
    agent,
    auth: "next",
  });
  assert.notEqual(
    updatedConnection.connection_id,
    beforeConnection.connection_id,
  );
  assert.notEqual(
    updatedConnection.token_digest,
    beforeConnection.token_digest,
  );
  checks += updatedConnection.checks + 2;
  assert.equal(
    await invoke(["volume", "ls", "-q", "--filter", "name=" + authMount.Name]),
    "",
  );
  checks++;
  assert.equal(
    (await lifecycle("disable", { expected_revision: revision })).inspection
      .lifecycle_state,
    "disabled",
  );
  const receiverVolumes = () =>
    invoke([
      "volume",
      "ls",
      "-q",
      "--filter",
      "label=" + scopeLabel + "=" + project,
      "--filter",
      "label=io.antnest.managed=runtime-auth",
    ]);
  assert.equal(await receiverVolumes(), "");
  checks++;
  await mutate(
    agent,
    "enable",
    {
      expected_revision: revision,
      configuration: { ...configuration, image_ref: "alpine:latest" },
    },
    "disallowed-enable",
    { auth: "next", status: 422, code: "image_not_allowed" },
  );
  await request({
    path: "/internal/runtime-operations/disallowed-enable",
    auth: "next",
    status: 404,
    code: "operation_not_found",
  });
  assert.equal(
    (await lifecycle("enable", { expected_revision: revision, configuration }))
      .inspection.lifecycle_state,
    "provisioned",
  );
  assert.equal(
    (await lifecycle("delete", { expected_revision: revision })).inspection
      .lifecycle_state,
    "deleted",
  );
  assert.equal(await receiverVolumes(), "");
  checks++;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    await invoke(["kill", "--signal", signal, id]);
    await invoke(["wait", id]);
    const [stopped] = JSON.parse(await invoke(["inspect", id]));
    assert.equal(stopped.State.ExitCode, 0);
    await invoke(["start", id]);
    await waitHealthy();
    await request({ auth: "next" });
    checks++;
  }
  const startupCases = [
    {
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_RUNTIME_INSTANCE_KEY_FILE: "",
    },
    {
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_RUNTIME_INSTANCE_KEY_FILE: "/run/auth/fixture.json",
    },
    {},
    { ANTNEST_SERVICE_AUTH_MODE: "token " },
    {
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "",
    },
    {
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_RUNTIME_CONTROLLER_LISTEN: ":8080",
    },
    {
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN: "0.0.0.0:8082",
    },
    {
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_RUNTIME_ALLOWED_IMAGES: '["alpine:latest"]',
    },
    {
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_SKILL_REGISTRY_API_TOKEN: "retired",
    },
  ];
  for (const [index, values] of startupCases.entries()) {
    const environment = {
      ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL:
        "postgres://unreachable.invalid/unreachable",
      ANTNEST_RUNTIME_MANAGEMENT_NETWORK: "unused",
      ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
      ANTNEST_SERVICE_AUTH_CALLERS_FILE: "/run/auth/callers.json",
      OTEL_SDK_DISABLED: "true",
      ...values,
    };
    const candidate = await invoke([
      "create",
      "--name",
      project + "-startup-" + index,
      "--label",
      scopeLabel + "=" + project,
      "--network",
      "none",
      "--mount",
      `type=bind,source=${directory},target=/run/auth,readonly`,
      ...Object.entries(environment).flatMap(([name, value]) => [
        "--env",
        name + "=" + value,
      ]),
      image,
    ]);
    await invoke(["start", candidate]);
    assert.equal(await invoke(["wait", candidate]), "1");
    assert(
      (await invoke(["logs", candidate])).includes("invalid_configuration"),
      "bad startup reached database instead of authentication/listener/image admission",
    );
    await invoke(["rm", candidate]);
    checks++;
  }
  const logs = await invoke([
    ...compose,
    "logs",
    "--no-color",
    "runtime-controller",
  ]);
  for (const secret of Object.values(keys)) assert(!logs.includes(secret));
  checks++;
  complete = true;
} catch (error) {
  // Preserve owning-service diagnostics before cleanup. Never echo Docker
  // create requests, bearer files or raw subprocess output to the caller.
  const diagnostics = dockerClient(env ?? process.env, undefined, 30000);
  if (compose) {
    try {
      await runCommand({
        name: "controller-diagnostics",
        command: [
          "docker",
          ...compose,
          "logs",
          "--no-color",
          "runtime-controller",
        ],
        cwd: root,
        env,
        output: evidence,
        timeoutMs: 10000,
      });
      for (const id of await owned(diagnostics, project, "container")) {
        await runCommand({
          name: "container-" + id,
          command: ["docker", "logs", "--tail", "100", id],
          cwd: root,
          env,
          output: evidence,
          timeoutMs: 10000,
        });
      }
    } catch {
      // The original gate error remains authoritative if Docker is unavailable.
    }
  }
  throw error;
} finally {
  clearTimeout(timer);
  const cleanup = dockerClient(env ?? process.env, undefined, 180000);
  try {
    if (compose)
      await cleanup(
        [
          ...compose,
          "down",
          "--volumes",
          "--remove-orphans",
          "--timeout",
          "15",
        ],
        true,
      );
    for (const kind of ["container", "volume", "network"]) {
      for (const id of await owned(cleanup, project, kind))
        await cleanup(
          kind === "container" ? ["rm", "-f", "-v", id] : [kind, "rm", id],
        );
      assert.deepEqual(await owned(cleanup, project, kind), []);
    }
    if (runtimeImage) {
      const ids = await cleanup(["image", "ls", "-q", runtimeImage]);
      if (ids) await cleanup(["image", "rm", runtimeImage]);
    }
    if (image) {
      const ids = await cleanup(["image", "ls", "-q", image]);
      if (ids) await cleanup(["image", "rm", image]);
    }
    cleaned = true;
  } finally {
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(
      resolve(evidence, "result.json"),
      JSON.stringify({ project, complete, cleaned, checks }) + "\n",
      { mode: 0o600 },
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.removeListener(signal, stop);
    console.log(JSON.stringify({ project, complete, cleaned, checks }));
  }
}
