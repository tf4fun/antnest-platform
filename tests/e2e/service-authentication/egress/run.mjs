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
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../support/run-command.mjs";
import {
  dockerClient,
  networkOctet,
  owned,
  scopeLabel,
} from "../../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const project = "antnest-egress-auth-" + randomUUID();
const evidence = resolve(
  root,
  "artifacts/verification/egress-authentication",
  project,
);
const directory = resolve(evidence, "credentials");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const keys = Object.fromEntries(
  ["current", "next", "wrong", "context"].map((name) => [
    name,
    randomBytes(32).toString("base64url"),
  ]),
);
writeFileSync(resolve(directory, "fixture.json"), JSON.stringify(keys), {
  mode: 0o600,
});
const saveCallers = (tokens) => {
  const digest = (value) =>
    "sha256:" + createHash("sha256").update(value).digest("hex");
  writeFileSync(
    resolve(directory, "callers.next.json"),
    JSON.stringify({
      "agent-controller": tokens.map(digest),
      "skill-registry": [digest(keys.wrong)],
    }),
    { mode: 0o600 },
  );
  renameSync(
    resolve(directory, "callers.next.json"),
    resolve(directory, "callers.json"),
  );
};
saveCallers([keys.current, keys.next]);
const sourceFiles = [
  "services/runtime-egress/Cargo.toml",
  "services/runtime-egress/Cargo.lock",
  "services/runtime-egress/Dockerfile",
  "services/runtime-egress/src/config.rs",
  "services/runtime-egress/src/control.rs",
  "services/runtime-egress/src/service_auth.rs",
  "services/runtime-egress/src/transport.rs",
  "services/runtime-egress/src/main.rs",
  "contracts/egress/control-contract.json",
  "contracts/egress/callers.json",
  "tests/e2e/service-authentication/egress/compose.yaml",
  "tests/e2e/service-authentication/egress/probe.mjs",
  "tests/e2e/service-authentication/egress/run.mjs",
];
const sourceIdentity = () =>
  Object.fromEntries(
    sourceFiles.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(resolve(root, path)))
        .digest("hex"),
    ]),
  );
const originalSources = sourceIdentity();
writeFileSync(
  resolve(evidence, "sources.json"),
  JSON.stringify(originalSources, null, 2),
  { mode: 0o600 },
);
const budget = 1800000;
const abort = new AbortController();
const stop = () => abort.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
const timer = setTimeout(stop, budget);
let env,
  compose,
  image,
  failure,
  stage = "starting",
  checks = 0,
  complete = false,
  cleaned;
const progress = (next) => {
  stage = next;
  writeFileSync(
    resolve(evidence, "progress.json"),
    JSON.stringify({ project, stage, checks }),
    { mode: 0o600 },
  );
};
try {
  const octet = await networkOctet(
    dockerClient(process.env, abort.signal, budget),
    1 + (process.pid % 200),
  );
  image = project + ":candidate";
  env = {
    ...process.env,
    EGRESS_AUTH_IMAGE: image,
    EGRESS_AUTH_DIRECTORY: directory,
    EGRESS_AUTH_DATABASE_PASSWORD: randomBytes(32).toString("hex"),
    EGRESS_AUTH_CONTROL_SUBNET: `10.242.${octet}.0/24`,
    EGRESS_AUTH_CONTROL_IP: `10.242.${octet}.10`,
    EGRESS_AUTH_PACKET_SUBNET: `10.243.${octet}.0/24`,
    EGRESS_AUTH_PACKET_IP: `10.243.${octet}.10`,
  };
  compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "--project-name",
    project,
    "-f",
    resolve(root, "tests/e2e/service-authentication/egress/compose.yaml"),
  ];
  const invoke = dockerClient(env, abort.signal, budget);
  progress("production-image-build");
  const build = await runCommand({
    name: "production-image-build",
    command: ["docker", ...compose, "build", "runtime-egress"],
    cwd: root,
    env,
    output: evidence,
    timeoutMs: budget,
    graceMs: 180000,
  });
  assert.equal(
    build.exit_code,
    0,
    "production image build failed; inspect private build evidence",
  );
  abort.signal.throwIfAborted();
  progress("isolated-startup");
  await invoke(
    [...compose, "up", "-d", "--no-build", "--wait", "--wait-timeout", "180"],
    true,
  );
  const id = await invoke([...compose, "ps", "-q", "runtime-egress"]);
  const [container] = JSON.parse(await invoke(["inspect", id]));
  assert.deepEqual(container.NetworkSettings.Ports, {});
  assert.equal(
    container.NetworkSettings.Networks[project + "_control"].IPAddress,
    env.EGRESS_AUTH_CONTROL_IP,
  );
  assert.equal(
    container.NetworkSettings.Networks[project + "_packet"].IPAddress,
    env.EGRESS_AUTH_PACKET_IP,
  );
  assert(
    container.Mounts.some(
      (mount) => mount.Destination === "/run/auth" && !mount.RW,
    ),
  );
  checks += 4;
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
  const request = async (options = {}) => {
    const result = await probe("control-probe", "request", options);
    checks++;
    return result;
  };
  const health = async () => {
    const result = JSON.parse(
      await invoke([
        "exec",
        id,
        "curl",
        "--max-time",
        "3",
        "-fsS",
        "http://127.0.0.1:8087/status",
      ]),
    );
    assert.deepEqual(Object.keys(result).sort(), [
      "control_plane_ready",
      "data_plane_ready",
      "snapshot_revision",
      "status",
    ]);
    assert.equal(typeof result.snapshot_revision, "number");
    checks++;
    return result;
  };
  const waitFor = async (name, work) => {
    const deadline = Date.now() + 60000;
    for (;;) {
      abort.signal.throwIfAborted();
      try {
        if (await work()) return;
      } catch {
        /* A bounded restart/reconnect poll may race listener startup. */
      }
      assert(Date.now() < deadline, name + " exceeded its recovery bound");
      await delay(500, undefined, { signal: abort.signal });
    }
  };
  const waitHealthy = () =>
    waitFor("Egress restart", async () => {
      await invoke([
        "exec",
        id,
        "/usr/local/bin/runtime-egress",
        "--healthcheck",
      ]);
      return (await health()).control_plane_ready;
    });
  const durable = async () => {
    const entries = [];
    for (const table of [
      "address_pools",
      "agent_networks",
      "policy_revisions",
      "agent_policy_assignments",
      "runtime_attachments",
    ])
      entries.push(
        JSON.parse(
          await invoke([
            ...compose,
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "egress_auth",
            "-d",
            "egress_auth_test",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM runtime_egress.${table} t`,
          ]),
        ),
      );
    return entries;
  };
  const rules = () =>
    invoke(["exec", id, "nft", "list", "table", "ip", "antnest_egress"]);
  const assertUnchanged = async (database, status, kernel) => {
    assert.deepEqual(await durable(), database);
    assert.equal((await health()).snapshot_revision, status.snapshot_revision);
    assert.equal(await rules(), kernel);
    checks += 3;
  };
  progress("route-admission");
  const empty = await durable(),
    initial = await health(),
    originalRules = await rules();
  assert.equal(initial.status, "ready");
  assert.equal(initial.data_plane_ready, true);
  checks += (await probe("control-probe", "matrix")).checks;
  await assertUnchanged(empty, initial, originalRules);
  checks += (await probe("packet-probe", "unreachable")).checks;
  progress("accepted-cas-and-carrier-validation");
  const agent = "accepted";
  const networkPath = `/internal/agent-networks/${agent}`;
  const attachmentPath = `/internal/agent-network-attachments/${agent}`;
  const assignmentPath = `/internal/agent-policy-assignments/${agent}`;
  const policyPath = "/internal/policies/accepted-policy/revisions/1";
  const network = await request({ method: "PUT", path: networkPath });
  assert.equal(network.tunnel_ipv4, "100.64.0.2");
  assert.equal(network.network_resource_version, 1);
  assert.equal(network.attachment_state, "closed");
  assert.deepEqual(
    await request({ method: "PUT", path: networkPath, auth: "next" }),
    network,
  );
  const spec = { schema_version: 1, action: "allow_all" };
  const policy = await request({
    method: "PUT",
    path: policyPath,
    body: { spec },
    media: "application/json; charset=UTF-8",
  });
  assert.deepEqual(
    await request({ method: "PUT", path: policyPath, body: { spec } }),
    policy,
  );
  assert.deepEqual((await request({ path: policyPath })).spec, spec);
  await request({
    method: "PUT",
    path: policyPath,
    body: { spec: { ...spec, action: "deny_all" } },
    status: 409,
    code: "policy_revision_conflict",
  });
  const assignmentBody = {
    policy_id: "accepted-policy",
    revision: 1,
    expected_resource_version: 1,
  };
  const assignment = await request({
    method: "PUT",
    path: assignmentPath,
    body: assignmentBody,
  });
  assert.equal(assignment.resource_version, 2);
  assert.deepEqual(
    await request({
      method: "PUT",
      path: assignmentPath,
      body: assignmentBody,
    }),
    assignment,
  );
  const open = await request({
    method: "PUT",
    path: attachmentPath,
    body: { state: "open", expected_resource_version: 1 },
  });
  assert.equal(open.attachment_resource_version, 2);
  assert.equal(open.attachment_state, "open");
  const activeDatabase = await durable(),
    activeStatus = await health(),
    activeRules = await rules();
  checks += (await probe("control-probe", "media")).checks;
  await request({
    method: "PUT",
    path: attachmentPath,
    body: { state: "closed", expected_resource_version: 1 },
    status: 409,
    code: "resource_version_conflict",
  });
  await request({
    method: "PUT",
    path: assignmentPath,
    body: { ...assignmentBody, policy_id: "builtin/deny-all" },
    status: 409,
    code: "resource_version_conflict",
  });
  await assertUnchanged(activeDatabase, activeStatus, activeRules);
  assert.equal((await request({ path: networkPath })).attachment_state, "open");
  const anonymousHealth = await invoke([
    "exec",
    id,
    "curl",
    "--max-time",
    "3",
    "-fsSI",
    "http://127.0.0.1:8087/status",
  ]);
  assert(anonymousHealth.startsWith("HTTP/1.1 200"));
  for (const path of ["/status?ignored=1", networkPath]) {
    const status = await invoke([
      "exec",
      id,
      "curl",
      "--max-time",
      "3",
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "http://127.0.0.1:8087" + path,
    ]);
    assert.equal(status, path.startsWith("/status") ? "400" : "404");
    checks++;
  }
  await invoke([
    "exec",
    "--env",
    "ANTNEST_SERVICE_AUTH_MODE=invalid",
    "--env",
    "ANTNEST_SERVICE_AUTH_CALLERS_FILE=/missing",
    "--env",
    "ANTNEST_EGRESS_DATABASE_URL=invalid",
    id,
    "/usr/local/bin/runtime-egress",
    "--healthcheck",
  ]);
  checks += 2;
  progress("receiver-rotation-and-recovery");
  saveCallers([keys.next]);
  await request({ path: networkPath });
  await invoke([...compose, "restart", "runtime-egress"], true);
  await waitHealthy();
  await request({
    path: networkPath,
    status: 401,
    code: "service_unauthenticated",
  });
  const recovered = await request({ path: networkPath, auth: "next" });
  assert.deepEqual(recovered, open);
  assert.deepEqual(
    await request({ path: assignmentPath, auth: "next" }),
    assignment,
  );
  for (const signal of ["SIGTERM", "SIGINT"]) {
    await invoke(["kill", "--signal", signal, id]);
    assert.equal(await invoke(["wait", id]), "0");
    const [stopped] = JSON.parse(await invoke(["inspect", id]));
    assert.equal(stopped.State.ExitCode, 0);
    await invoke(["start", id]);
    await waitHealthy();
    assert.deepEqual(await request({ path: networkPath, auth: "next" }), open);
    checks++;
  }
  progress("local-health-during-database-outage");
  await invoke([...compose, "stop", "postgres"], true);
  await waitFor(
    "database loss observation",
    async () => !(await health()).control_plane_ready,
  );
  const degraded = await health();
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.data_plane_ready, true);
  await invoke(["exec", id, "/usr/local/bin/runtime-egress", "--healthcheck"]);
  await invoke([...compose, "start", "postgres"], true);
  await waitFor("database reconnect", async () => {
    await request({ path: networkPath, auth: "next" });
    return (await health()).control_plane_ready;
  });
  const closed = await request({
    path: attachmentPath,
    method: "PUT",
    auth: "next",
    body: { state: "closed", expected_resource_version: 2 },
  });
  assert.equal(closed.attachment_resource_version, 3);
  const released = await request({
    path: networkPath + "/release",
    method: "POST",
    auth: "next",
    body: { expected_resource_version: 1 },
  });
  assert.equal(released.state, "quarantined");
  assert.equal(released.network_resource_version, 2);
  assert.deepEqual(
    await request({
      path: networkPath + "/release",
      method: "POST",
      auth: "next",
      body: { expected_resource_version: 1 },
    }),
    released,
  );
  checks += 3;
  progress("startup-fails-before-effects");
  const startupCases = [
    [{}, "ConfigError"],
    [{ ANTNEST_SERVICE_AUTH_MODE: "token " }, "ConfigError"],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: " true",
      },
      "ConfigError",
    ],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "false",
      },
      "ConfigError",
    ],
    [{ ANTNEST_SERVICE_AUTH_MODE: "mtls" }, "ConfigError"],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_SERVICE_AUTH_CALLERS_FILE: "/missing",
      },
      "ConfigError",
    ],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_TLS_CA_FILE: "/run/auth/callers.json",
      },
      "ConfigError",
    ],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_EGRESS_CONTROL_LISTEN: "0.0.0.0:8181",
      },
      'Invalid("ANTNEST_EGRESS_CONTROL_LISTEN")',
    ],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_EGRESS_CONTROL_LISTEN: "127.0.0.2:8181",
      },
      'Invalid("ANTNEST_EGRESS_CONTROL_LISTEN")',
    ],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_EGRESS_HEALTH_LISTEN: "0.0.0.0:8087",
      },
      'Invalid("ANTNEST_EGRESS_HEALTH_LISTEN")',
    ],
    [
      {
        ANTNEST_SERVICE_AUTH_MODE: "token",
        ANTNEST_EGRESS_HEALTH_LISTEN: "127.0.0.1:8181",
      },
      'Invalid("ANTNEST_EGRESS_HEALTH_LISTEN")',
    ],
  ];
  for (const [index, [values, code]] of startupCases.entries()) {
    const environment = {
      ANTNEST_EGRESS_DATABASE_URL: "postgres://unreachable.invalid/unreachable",
      ANTNEST_EGRESS_DATABASE_TLS_MODE: "disable",
      ANTNEST_EGRESS_CONTROL_LISTEN: "127.0.0.1:8181",
      ANTNEST_EGRESS_HEALTH_LISTEN: "127.0.0.1:8087",
      ANTNEST_EGRESS_UDP_ADVERTISE: "127.0.0.2:8092",
      ANTNEST_EGRESS_DNS_UPSTREAM: "127.0.0.1:53",
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
    const record = "startup-" + index;
    const captured = await runCommand({
      name: record,
      command: ["docker", "logs", candidate],
      cwd: root,
      env,
      output: evidence,
      timeoutMs: 10000,
      graceMs: 10000,
    });
    assert.equal(captured.exit_code, 0);
    const logs = readFileSync(resolve(evidence, record + ".log"), "utf8");
    assert(
      logs.includes(code),
      "bad configuration reached database/kernel initialization",
    );
    assert(!logs.includes(directory));
    for (const secret of Object.values(keys)) assert(!logs.includes(secret));
    await invoke(["rm", candidate]);
    checks++;
  }
  progress("privacy-and-source-integrity");
  const captured = await runCommand({
    name: "service-logs",
    command: ["docker", ...compose, "logs", "--no-color", "runtime-egress"],
    cwd: root,
    env,
    output: evidence,
    timeoutMs: 10000,
    graceMs: 10000,
  });
  assert.equal(captured.exit_code, 0);
  const logs = readFileSync(resolve(evidence, "service-logs.log"), "utf8");
  assert(
    logs.includes("Runtime Egress ready"),
    "service log privacy check had no startup evidence",
  );
  for (const secret of [
    ...Object.values(keys),
    env.EGRESS_AUTH_DATABASE_PASSWORD,
  ])
    assert(!logs.includes(secret), "service logs leaked an authority carrier");
  assert.deepEqual(
    sourceIdentity(),
    originalSources,
    "sources changed during production image admission",
  );
  checks += 2;
  complete = true;
} catch (error) {
  failure = error;
  writeFileSync(
    resolve(evidence, "failure.txt"),
    String(error.stack ?? error),
    { mode: 0o600 },
  );
  if (compose) {
    try {
      await runCommand({
        name: "diagnostics",
        command: ["docker", ...compose, "logs", "--no-color"],
        cwd: root,
        env,
        output: evidence,
        timeoutMs: 15000,
        graceMs: 15000,
      });
    } catch {
      /* Preserve the original failure if the Docker daemon is unavailable. */
    }
  }
} finally {
  clearTimeout(timer);
  const cleanup = dockerClient(env ?? process.env, undefined, 240000);
  const errors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt(async () => {
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
  });
  for (const kind of ["container", "volume", "network"]) {
    await attempt(async () => {
      for (const id of await owned(cleanup, project, kind)) {
        const [resource] = JSON.parse(
          await cleanup(
            kind === "container" ? ["inspect", id] : [kind, "inspect", id],
          ),
        );
        const labels =
          kind === "container" ? resource.Config.Labels : resource.Labels;
        const owners = [
          labels?.["com.docker.compose.project"],
          labels?.[scopeLabel],
        ].filter(Boolean);
        assert(
          owners.length && owners.every((owner) => owner === project),
          "cleanup ownership conflict",
        );
        await cleanup(
          kind === "container" ? ["rm", "-f", "-v", id] : [kind, "rm", id],
        );
      }
      assert.deepEqual(await owned(cleanup, project, kind), []);
    });
  }
  await attempt(async () => {
    if (image && (await cleanup(["image", "ls", "-q", image])))
      await cleanup(["image", "rm", image]);
  });
  cleaned = errors.length === 0;
  rmSync(directory, { recursive: true, force: true });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.removeListener(signal, stop);
  writeFileSync(
    resolve(evidence, "result.json"),
    JSON.stringify({ project, stage, complete, cleaned, checks }) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ project, stage, complete, cleaned, checks }));
  if (failure || !cleaned) {
    console.error(
      "Egress owning-service gate failed; inspect private verification evidence.",
    );
    process.exitCode = 1;
  }
}
