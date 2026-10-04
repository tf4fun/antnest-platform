import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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
const abort = new AbortController();
const stop = () => abort.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
const timer = setTimeout(stop, 600000);
const docker = dockerClient(process.env, abort.signal, 600000);
let env,
  compose,
  image,
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
  const probe = async (service, mode, options = {}) =>
    JSON.parse(
      await invoke([
        ...compose,
        "exec",
        "-T",
        service,
        "node",
        "/fixture/probe.mjs",
        mode,
        JSON.stringify(options),
      ]),
    );
  checks += (await probe("control-probe", "matrix")).checks;
  checks += (await probe("management-probe", "unreachable")).checks;
  const request = async (options) => {
    const result = await probe("control-probe", "request", options);
    checks++;
    return result;
  };
  const runtimeImage = "antnest/antnest-runtime:local";
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
      packet_contract_revision: 1,
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
  assert.equal(
    (await lifecycle("disable", { expected_revision: revision })).inspection
      .lifecycle_state,
    "disabled",
  );
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
