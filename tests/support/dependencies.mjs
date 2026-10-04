import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  dockerClient,
  networkOctet,
} from "../e2e/lifecycle-closeout/docker.mjs";
import { runCommand } from "./run-command.mjs";
import { durablePath } from "./storage.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const roles = {
  EGRESS: "egress",
  RUNTIME_CONTROLLER: "runtime_controller",
  AGENT_ACP: "agent_acp",
  IDENTITY: "identity",
  AGENT_CONTROLLER: "agent_controller",
  TEMPORAL: "temporal",
};

export function dependencyPlan(profile, inherited = process.env) {
  assert(
    ["postgres", "temporal"].includes(profile),
    "unknown dependency profile",
  );
  const project = `antnest-dependencies-${randomUUID()}`;
  const env = {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(key),
      ),
    ),
    COMPOSE_PROJECT_NAME: project,
    ANTNEST_POSTGRES_HOST_PORT: "0",
    ANTNEST_TEMPORAL_HOST_PORT: "0",
    ANTNEST_POSTGRES_ADMIN_PASSWORD: "integration-admin",
    // Render inactive workload declarations without opening any credential files.
    ANTNEST_SERVICE_AUTH_DIRECTORY: "/never-mounted-dependency-credentials",
    ANTNEST_SERVICE_AUTH_UID: "65532",
    ANTNEST_SERVICE_AUTH_GID: "65532",
    ANTNEST_IDENTITY_CCT_SIGNING_KID: "dependency-unused",
  };
  for (const key of Object.keys(roles))
    env[`ANTNEST_${key}_POSTGRES_PASSWORD`] =
      `integration-${key.toLowerCase()}`;
  return {
    project,
    env,
    services:
      profile === "temporal"
        ? ["postgres", "temporal", "diagnostic-relay"]
        : ["postgres", "diagnostic-relay"],
    compose: [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-name",
      project,
      "-f",
      resolve(root, "compose.yaml"),
      "-f",
      resolve(root, "compose.debug.yaml"),
      "-f",
      resolve(root, "tests/support/compose.dependencies.yaml"),
      "--profile",
      "stage3",
    ],
  };
}

export async function withDependencies({
  profile,
  command,
  output,
  name,
  dockerFactory = dockerClient,
  timeoutMs = 1200000,
  graceMs = 180000,
  startupWaitSeconds = 180,
  cwd = root,
}) {
  output = durablePath(output);
  cwd = durablePath(cwd);
  for (const value of [timeoutMs, graceMs, startupWaitSeconds])
    assert(
      Number.isSafeInteger(value) && value > 0,
      "dependency limits must be positive integers",
    );
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name), "invalid evidence name");
  assert(
    Array.isArray(command) &&
      command.length > 0 &&
      command.every((arg) => typeof arg === "string"),
  );
  for (const suffix of ["log", "result.json", "cleanup.json"])
    assert(
      !existsSync(resolve(output, `${name}.${suffix}`)),
      "dependency evidence already exists",
    );
  const plan = dependencyPlan(profile);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  const docker = dockerFactory(plan.env, controller.signal, 1800000);
  let result,
    primaryError,
    cleanupError,
    stage = "starting",
    cleaned = false;
  try {
    plan.env.ANTNEST_SERVICE_NETWORK_PREFIX = `10.242.${await networkOctet(docker, 1 + (process.pid % 200))}`;
    await docker(
      [
        ...plan.compose,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        String(startupWaitSeconds),
        "--no-build",
        "--pull",
        "never",
        ...plan.services,
      ],
      true,
    );
    if (profile === "temporal")
      await docker(
        [...plan.compose, "run", "--rm", "--no-deps", "temporal-namespace"],
        true,
      );
    stage = "configuring";
    const ids = (await docker([...plan.compose, "ps", "-q", ...plan.services]))
      .split(/\s+/)
      .filter(Boolean);
    const rows = JSON.parse(await docker(["inspect", ...ids]));
    const port = (internal) => {
      const row = rows.find(
        (item) =>
          item.Config.Labels["com.docker.compose.service"] ===
          "diagnostic-relay",
      );
      const bindings = row?.NetworkSettings.Ports[`${internal}/tcp`];
      assert(
        bindings?.[0]?.HostIp === "127.0.0.1",
        "dependency must bind loopback",
      );
      return bindings[0].HostPort;
    };
    const pg = port(5432);
    const env = {
      ...plan.env,
      GOCACHE: resolve(root, ".cache/go-build"),
      GOMODCACHE: resolve(root, ".cache/go-mod"),
    };
    for (const [key, role] of Object.entries(roles).filter(
      ([key]) => key !== "TEMPORAL",
    )) {
      const database = `antnest_${role}_test`;
      await docker([
        ...plan.compose,
        "exec",
        "-T",
        "postgres",
        "createdb",
        "-U",
        "antnest_test_admin",
        "-O",
        `antnest_${role}`,
        database,
      ]);
      await docker([
        ...plan.compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "postgres",
        "-c",
        `REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`,
      ]);
      env[`ANTNEST_${key === "AGENT_ACP" ? "ACP" : key}_TEST_DATABASE_URL`] =
        `postgres://antnest_${role}:${env[`ANTNEST_${key}_POSTGRES_PASSWORD`]}@127.0.0.1:${pg}/${database}${key === "EGRESS" ? "" : "?sslmode=disable"}`;
    }
    env.ANTNEST_EGRESS_TEST_ADMIN_DATABASE_URL = `postgres://antnest_test_admin:${env.ANTNEST_POSTGRES_ADMIN_PASSWORD}@127.0.0.1:${pg}/antnest_egress_test`;
    // Proxy integration fixtures reset their tables: never inherit a retained URL.
    env.TEST_POSTGRES_URL = env.ANTNEST_ACP_TEST_DATABASE_URL;
    await docker([
      ...plan.compose,
      "exec",
      "-T",
      "postgres",
      "createdb",
      "-U",
      "antnest_test_admin",
      "-O",
      "antnest_agent_acp",
      "antnest_agent_acp_audit",
    ]);
    await docker([
      ...plan.compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "postgres",
      "-c",
      "REVOKE CONNECT ON DATABASE antnest_agent_acp_audit FROM PUBLIC",
    ]);
    env.ANTNEST_ACP_AUDIT_DATABASE_URL = `postgres://antnest_agent_acp:${env.ANTNEST_AGENT_ACP_POSTGRES_PASSWORD}@127.0.0.1:${pg}/antnest_agent_acp_audit?sslmode=disable`;
    if (profile === "temporal")
      env.ANTNEST_TEMPORAL_TEST_ADDRESS = `127.0.0.1:${port(7233)}`;
    controller.signal.throwIfAborted();
    stage = "running";
    result = await runCommand({
      command,
      output,
      name,
      env,
      cwd,
      timeoutMs,
      graceMs,
    });
    stage = "finished";
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = dockerFactory(plan.env, undefined, 240000);
    try {
      await cleanup(
        [
          ...plan.compose,
          "down",
          "--volumes",
          "--remove-orphans",
          "--timeout",
          "30",
        ],
        true,
      );
      for (const args of [
        ["ps", "-aq"],
        ["volume", "ls", "-q"],
        ["network", "ls", "-q"],
      ]) {
        assert.equal(
          await cleanup([
            ...args,
            "--filter",
            `label=com.docker.compose.project=${plan.project}`,
          ]),
          "",
          "dependency resource leak",
        );
      }
      cleaned = true;
    } catch (error) {
      cleanupError = error;
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
      const errorType = (error) =>
        error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
          ? error.name
          : "Error";
      writeFileSync(
        resolve(output, `${name}.cleanup.json`),
        JSON.stringify({
          project: plan.project,
          cleanup: cleaned,
          stage,
          ...(primaryError
            ? { primary_error_type: errorType(primaryError) }
            : {}),
          ...(cleanupError
            ? { cleanup_error_type: errorType(cleanupError) }
            : {}),
          ...(result ? { exit_code: result.exit_code } : {}),
        }),
        { flag: "wx", mode: 0o600 },
      );
    }
  }
  if (primaryError && cleanupError)
    throw new AggregateError(
      [primaryError, cleanupError],
      "Dependency execution and cleanup failed; see private evidence",
    );
  if (primaryError || cleanupError) throw primaryError ?? cleanupError;
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string", default: "postgres" },
      output: {
        type: "string",
        default: "artifacts/verification/dependencies",
      },
      name: { type: "string" },
      "timeout-ms": { type: "string", default: "1200000" },
      "grace-ms": { type: "string", default: "180000" },
      "startup-wait-seconds": { type: "string", default: "180" },
      cwd: { type: "string", default: root },
    },
  });
  assert(
    values.name && positionals.length,
    "expected --name NAME -- COMMAND ARGS",
  );
  try {
    const result = await withDependencies({
      profile: values.profile,
      command: positionals,
      output: resolve(values.output),
      name: values.name,
      timeoutMs: Number(values["timeout-ms"]),
      graceMs: Number(values["grace-ms"]),
      startupWaitSeconds: Number(values["startup-wait-seconds"]),
      cwd: values.cwd,
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exit_code;
  } catch {
    console.error(
      "Dependency verification failed; inspect private cleanup evidence.",
    );
    process.exitCode = 1;
  }
}
