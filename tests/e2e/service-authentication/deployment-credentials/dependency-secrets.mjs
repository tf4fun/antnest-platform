import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyPlan } from "../../../support/dependencies.mjs";
import { runCommand } from "../../../support/run-command.mjs";
import { durablePath } from "../../../support/storage.mjs";
import {
  dockerClient,
  networkOctet,
  owned,
  scopeLabel,
  stderrDiagnostic,
} from "../../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const run = `antnest-dependency-secrets-${randomUUID().slice(0, 8)}`;
const output = durablePath(
  resolve(root, "artifacts/verification/dependency-secrets", run),
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const policy = JSON.parse(
  readFileSync(
    resolve(root, "contracts/platform/development-secrets.json"),
    "utf8",
  ),
);
const admin = "ANTNEST_POSTGRES_ADMIN_PASSWORD";
const temporal = "ANTNEST_TEMPORAL_POSTGRES_PASSWORD";
const abort = new AbortController();
const stop = () => abort.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const timer = setTimeout(stop, 600000);
const inherited = dependencyPlan("temporal", process.env).env;
delete inherited[policy.opt_in_variable];
const docker = dockerClient(inherited, abort.signal, 600000);
const projects = [run];
let checks = 0,
  stage = "images",
  failure,
  cleaned;
const record = (name, data) =>
  writeFileSync(resolve(output, name), JSON.stringify(data) + "\n", {
    flag: "wx",
    mode: 0o600,
  });

async function inspect(client, id, project) {
  const [row] = JSON.parse(await client(["inspect", id]));
  assert.equal(row.Config.Labels["com.docker.compose.project"], project);
  assert(
    !row.Config.Labels[scopeLabel] || row.Config.Labels[scopeLabel] === project,
  );
  return row;
}

async function clean(client, project) {
  for (const kind of ["container", "volume", "network"]) {
    for (const id of await owned(client, project, kind)) {
      const [row] = JSON.parse(
        await client(
          kind === "container" ? ["inspect", id] : [kind, "inspect", id],
        ),
      );
      const labels = kind === "container" ? row.Config.Labels : row.Labels;
      const owners = [
        labels?.["com.docker.compose.project"],
        labels?.[scopeLabel],
      ].filter(Boolean);
      assert(
        owners.length && owners.every((owner) => owner === project),
        "conflicting cleanup ownership",
      );
      await client(
        kind === "container" ? ["rm", "-f", "-v", id] : [kind, "rm", id],
      );
    }
    assert.deepEqual(await owned(client, project, kind), []);
  }
}

async function scenario(name, published, enabled, action) {
  const project = `${run}-${name}`;
  projects.push(project);
  const env = {
    ...inherited,
    ...Object.fromEntries(
      policy.password_variables.map((variable) => [
        variable,
        randomBytes(32).toString("hex"),
      ]),
    ),
    COMPOSE_PROJECT_NAME: project,
    ANTNEST_SERVICE_NETWORK_PREFIX: `10.242.${await networkOctet(docker, 1 + (process.pid % 200))}`,
  };
  if (published) {
    env[admin] = "antnest-postgres-dev";
    env[temporal] = "antnest-temporal-dev";
  }
  if (enabled) env[policy.opt_in_variable] = "true";
  const client = dockerClient(env, abort.signal, 600000);
  const compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "--project-name",
    project,
    "-f",
    resolve(root, "compose.yaml"),
    ...(enabled
      ? [
          "-f",
          resolve(
            root,
            "tests/support/compose.public-development-secrets.yaml",
          ),
        ]
      : []),
    "--profile",
    "stage3",
  ];
  const idFor = async (service) => {
    const id = await client([...compose, "ps", "--all", "--quiet", service]);
    assert.match(id, /^[a-f0-9]{64}$/u, `${service} container missing`);
    await inspect(client, id, project);
    return id;
  };
  async function logs(service, expected, suffix) {
    const id = await idFor(service);
    const name = `${namePrefix(service)}-${suffix}`;
    const result = await runCommand({
      command: ["docker", "logs", id],
      output,
      name,
      env,
      cwd: root,
      timeoutMs: 10000,
      graceMs: 1000,
    });
    assert.equal(result.exit_code, 0, "container log capture failed");
    const text = readFileSync(resolve(output, `${name}.log`), "utf8");
    for (const value of [
      ...policy.published_values,
      ...policy.password_variables.map((variable) => env[variable]),
    ])
      assert(!text.includes(value), `${service} log leaked a password`);
    const warnings = text
      .split("\n")
      .filter((line) =>
        /^WARN Published development secret explicitly enabled: /u.test(line),
      );
    assert.equal(warnings.length, expected.length, `${service} WARN count`);
    assert.deepEqual(
      warnings.map((line) => line.split(": ").at(-1)).sort(),
      [...expected].sort(),
    );
    checks++;
    return text;
  }
  const namePrefix = (service) => `${name}-${service}`;
  async function start(
    service,
    { healthy = false, rejected, suffix = "startup", warnings = [] } = {},
  ) {
    stage = `${namePrefix(service)}-${suffix}`;
    console.log(JSON.stringify({ stage, status: "running" }));
    let upError;
    try {
      await client(
        [
          ...compose,
          "up",
          "-d",
          "--no-deps",
          "--no-build",
          "--pull",
          "never",
          "--force-recreate",
          ...(healthy ? ["--wait", "--wait-timeout", "180"] : []),
          service,
        ],
        true,
      );
    } catch (error) {
      if (!rejected) throw error;
      upError = error;
    }
    const id = await idFor(service);
    const row = await inspect(client, id, project);
    if (healthy) {
      assert.equal(row.State.Running, true);
      assert.equal(row.State.Health?.Status, "healthy");
      checks++;
    } else {
      const exit = Number(await client(["wait", id], true));
      if (rejected)
        assert.notEqual(exit, 0, `${service} admitted a published value`);
      else assert.equal(exit, 0, `${service} initialization failed`);
      assert.equal((await inspect(client, id, project)).State.Running, false);
      checks++;
    }
    const gate = row.Config.Env.find((value) =>
      value.startsWith(`${policy.opt_in_variable}=`),
    );
    assert.equal(
      gate,
      enabled
        ? `${policy.opt_in_variable}=${env[policy.opt_in_variable]}`
        : undefined,
    );
    const text = await logs(service, warnings, suffix);
    if (rejected) {
      assert(
        text.includes(`${rejected} uses a published development value`),
        `${service} missing sanitized rejection`,
      );
      assert(!text.includes("database system is ready to accept connections"));
      checks++;
    } else if (upError) throw upError;
    console.log(JSON.stringify({ stage, status: "passed" }));
    return { id, row };
  }
  try {
    await action({ client, compose, env, start, logs, idFor, project });
  } finally {
    await clean(dockerClient(env, undefined, 120000), project);
  }
}

try {
  const imageNames = [
    "postgres:17.11-bookworm",
    "temporalio/admin-tools:1.32.0",
    "temporalio/server:1.32.0",
    "antnest/temporal:local",
  ];
  const images = JSON.parse(await docker(["image", "inspect", ...imageNames]));
  const upstream = images[2].Config,
    derived = images[3].Config;
  // The upstream server image starts through Cmd with no Entrypoint.
  assert(
    [...(upstream.Entrypoint ?? []), ...(upstream.Cmd ?? [])].includes(
      "/etc/temporal/entrypoint.sh",
    ),
  );
  for (const field of ["Entrypoint", "Cmd", "User", "WorkingDir"])
    assert.deepEqual(
      derived[field],
      upstream[field],
      `Temporal inherited ${field}`,
    );
  record(
    "images.json",
    images.map(({ Id, RepoTags, Config }) => ({
      Id,
      RepoTags,
      entrypoint: Config.Entrypoint,
      command: Config.Cmd,
      user: Config.User,
    })),
  );
  for (const [index, image] of imageNames.entries()) {
    const shell = await docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      `${run}-shell-${index}`,
      "--label",
      `${scopeLabel}=${run}`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--mount",
      `type=bind,src=${resolve(root, "scripts/development-secret-admission.sh")},dst=/admission.sh,readonly`,
      "--entrypoint",
      "sh",
      image,
      "-c",
      "set -eu; ls -l /bin/sh; sh -n /admission.sh; ANTNEST_POSTGRES_ADMIN_PASSWORD=private sh /admission.sh ANTNEST_POSTGRES_ADMIN_PASSWORD",
    ]);
    record(`shell-${index}.json`, { image, shell });
    checks++;
  }
  await scenario("blocked", true, false, async ({ env, start }) => {
    await start("postgres", { rejected: admin });
    await start("temporal-databases", {
      rejected: admin,
      suffix: "admin-rejection",
    });
    env[admin] = randomBytes(32).toString("hex");
    await start("temporal-databases", {
      rejected: temporal,
      suffix: "temporal-rejection",
    });
    await start("temporal-schema", { rejected: temporal });
    await start("temporal", { rejected: temporal });
    env[admin] = "antnest-postgres-dev";
    await start("skill-registry-database-init", { rejected: admin });
  });
  for (const enabled of [true, false])
    await scenario(
      enabled ? "opted-in" : "private",
      enabled,
      enabled,
      async ({ client, compose, env, start, logs, idFor, project }) => {
        const expected = (variables) => (enabled ? variables : []);
        const postgres = await start("postgres", {
          healthy: true,
          warnings: expected([admin]),
        });
        await start("temporal-databases", {
          warnings: expected([admin, temporal]),
        });
        await start("temporal-schema", { warnings: expected([temporal]) });
        await start("skill-registry-database-init", {
          warnings: expected([admin]),
        });
        await start("temporal", {
          healthy: true,
          warnings: expected([temporal]),
        });
        for (const service of ["temporal", "postgres"])
          await client([...compose, "stop", "--timeout", "30", service], true);
        for (const service of ["temporal", "postgres"]) {
          const row = await inspect(client, await idFor(service), project);
          assert.equal(row.State.ExitCode, 0, `${service} signal handling`);
          checks++;
        }
        for (const service of ["postgres", "temporal"])
          await client(
            [
              ...compose,
              "up",
              "-d",
              "--no-deps",
              "--no-build",
              "--pull",
              "never",
              "--wait",
              "--wait-timeout",
              "180",
              service,
            ],
            true,
          );
        for (const [service, variable] of [
          ["postgres", admin],
          ["temporal", temporal],
        ]) {
          const row = await inspect(client, await idFor(service), project);
          assert.equal(row.State.Health.Status, "healthy");
          await logs(service, expected([variable, variable]), "restart");
          checks++;
        }
        if (enabled) {
          for (const service of ["temporal", "postgres"])
            await client(
              [...compose, "stop", "--timeout", "30", service],
              true,
            );
          // Keep the same initialized volume but recreate PostgreSQL without its fixture gate.
          env[policy.opt_in_variable] = "false";
          const rejected = await start("postgres", {
            rejected: admin,
            suffix: "retained-data-rejection",
          });
          const volume = (row) =>
            row.Mounts.find(
              ({ Destination }) => Destination === "/var/lib/postgresql/data",
            ).Name;
          assert.equal(volume(rejected.row), volume(postgres.row));
          checks++;
        }
      },
    );
} catch (error) {
  failure = error;
  record("failure.json", {
    stage,
    error_type: error.name,
    message: stderrDiagnostic(error.message, inherited),
  });
} finally {
  clearTimeout(timer);
  const cleanup = dockerClient(inherited, undefined, 180000);
  const errors = [];
  for (const project of projects)
    try {
      await clean(cleanup, project);
    } catch (error) {
      errors.push(error);
    }
  cleaned = errors.length === 0;
  if (errors.length)
    failure ??= new AggregateError(
      errors,
      "Dependency admission cleanup failed",
    );
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  record("result.json", {
    checks,
    cleanup: cleaned,
    status: failure ? "failed" : "passed",
    last_stage: stage,
  });
}
console.log(
  JSON.stringify({
    checks,
    cleanup: cleaned,
    status: failure ? "failed" : "passed",
    last_stage: stage,
    evidence: output,
  }),
);
if (failure) process.exitCode = 1;
