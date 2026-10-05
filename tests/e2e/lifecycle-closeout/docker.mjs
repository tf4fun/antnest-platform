import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverNetworkOctet } from "../acp-closeout/network.mjs";
import { dockerInvocation } from "../acp-closeout/docker.mjs";
import {
  fixtureEnvironment,
  prepareFixtureCredentials,
} from "../../support/authenticated-e2e.mjs";

export const scopeLabel = "io.antnest.runtime-controller-scope";
export const lines = (value) => value.trim().split(/\s+/).filter(Boolean);

export async function networkOctet(docker, seed) {
  const listed = await docker(["network", "ls", "-q"]);
  const ids = lines(listed);
  const inspected = ids.length
    ? await docker(["network", "inspect", ...ids])
    : "[]";
  return discoverNetworkOctet(
    (args) => (args[1] === "ls" ? listed : inspected),
    seed,
  );
}

export function dockerClient(env, signal, budget = 900000) {
  const deadline = Date.now() + budget;
  return async function docker(args, long = false) {
    signal?.throwIfAborted();
    const invocation = dockerInvocation(
      long ? ["--lifecycle", ...args] : args,
      deadline,
    );
    assert(invocation, "Docker integration deadline exceeded");
    const commandFailure = new Error(`Docker ${args[0]} failed`);
    return new Promise((resolve, reject) => {
      const child = spawn("docker", invocation.args, {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let failure;
      const terminate = () => {
        failure = new Error(`Docker ${args[0]} interrupted or timed out`);
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") failure = error;
        }
      };
      child.stdout.on("data", (value) => {
        output += value;
        if (output.length > 8 * 1024 * 1024) terminate();
      });
      // Command output can contain integration credentials; never echo raw stderr.
      child.stderr.resume();
      const timer = setTimeout(terminate, invocation.timeoutMs);
      signal?.addEventListener("abort", terminate, { once: true });
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", terminate);
        if (failure || code !== 0) {
          commandFailure.message += ` (${code})`;
          reject(failure ?? commandFailure);
        } else resolve(output.trim());
      });
    });
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function configuration(signal, beforeEffects = () => {}) {
  const project = `antnest-lifecycle-${randomUUID().slice(0, 8)}`;
  beforeEffects(project);
  const docker = dockerClient(process.env, signal);
  const octet = await networkOctet(docker, 1 + (process.pid % 200));
  const image = "antnest/antnest-runtime:local";
  const resolvedImage = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  assert.match(resolvedImage, /^sha256:[a-f0-9]{64}$/);
  const ports = new Set();
  while (ports.size < 4) ports.add(await freePort());
  const [pg, edge, jaeger, model] = [...ports];
  const gateway = `http://127.0.0.1:${edge}`;
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const prepared = prepareFixtureCredentials(project, root);
  const env = {
    ...fixtureEnvironment(process.env, { project, octet }),
    ...prepared.environment,
    ANTNEST_POSTGRES_HOST_PORT: String(pg),
    ANTNEST_EDGE_HOST_PORT: String(edge),
    ANTNEST_JAEGER_UI_HOST_PORT: String(jaeger),
    ANTNEST_LIFECYCLE_MODEL_HOST_PORT: String(model),
    ANTNEST_EDGE_PUBLIC_BASE_URL: gateway,
    ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: image,
    ANTNEST_E2E_ALLOW_PRIVATE_PROVIDER_ENDPOINTS: "true",
    ANTNEST_IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
    ANTNEST_TEMPORAL_HOST_PORT: "0",
    ANTNEST_RUNTIME_CONTROLLER_HOST_PORT: "0",
    ANTNEST_ACP_HOST_PORT: "0",
    ANTNEST_IDENTITY_HOST_PORT: "0",
    ANTNEST_AGENT_CONTROLLER_HOST_PORT: "0",
    ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG: "stage3",
    ANTNEST_BOOTSTRAP_ORGANIZATION_NAME: "Lifecycle test",
    ANTNEST_BOOTSTRAP_ADMIN_EMAIL: "stage3-admin@example.com",
    ANTNEST_BOOTSTRAP_ADMIN_PASSWORD: "stage3-admin-password",
    OTEL_SDK_DISABLED: "false",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
  };
  return {
    project,
    image,
    resolvedImage,
    credentials: prepared.credentials,
    env,
    gateway,
    jaeger: `http://127.0.0.1:${jaeger}`,
    model: `http://127.0.0.1:${model}`,
  };
}

export function composeArgs(project, args) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/);
  return [
    "compose",
    "--env-file",
    "/dev/null",
    "--project-name",
    project,
    "-f",
    "compose.yaml",
    "-f",
    "tests/support/compose.public-development-secrets.yaml",
    "-f",
    "compose.debug.yaml",
    "-f",
    "compose.stage3.yaml",
    "-f",
    "tests/e2e/lifecycle-closeout/compose.yaml",
    "--profile",
    "stage3",
    "--profile",
    "stage3-e2e",
    "--profile",
    "observability",
    ...args,
  ];
}

export async function owned(docker, project, kind) {
  const prefix = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
  const ids = new Set();
  for (const label of ["com.docker.compose.project", scopeLabel]) {
    for (const id of lines(
      await docker([...prefix, "--filter", `label=${label}=${project}`]),
    ))
      ids.add(id);
  }
  return [...ids];
}

async function inspectOwned(docker, project, kind, id) {
  const args = kind === "container" ? ["inspect", id] : [kind, "inspect", id];
  const resource = JSON.parse(await docker(args))[0];
  const labels =
    kind === "container" ? resource?.Config?.Labels : resource?.Labels;
  const owners = [
    labels?.["com.docker.compose.project"],
    labels?.[scopeLabel],
  ].filter(Boolean);
  assert(
    owners.length && owners.every((owner) => owner === project),
    `${kind} ${id}: conflicting or missing cleanup ownership`,
  );
  return labels;
}

export async function cleanup(
  config,
  docker = dockerClient(config.env, undefined, 180000),
) {
  const errors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  composeArgs(config.project, []);
  await attempt(async () => {
    for (const id of await owned(docker, config.project, "container")) {
      await attempt(async () => {
        const labels = await inspectOwned(
          docker,
          config.project,
          "container",
          id,
        );
        if (
          ["agent-controller", "runtime-controller"].includes(
            labels["com.docker.compose.service"],
          )
        )
          await docker(["stop", "-t", "10", id]);
      });
    }
  });
  for (const kind of ["container", "volume", "network"]) {
    await attempt(async () => {
      for (const id of await owned(docker, config.project, kind)) {
        await attempt(async () => {
          await inspectOwned(docker, config.project, kind, id);
          await docker(
            kind === "container" ? ["rm", "-f", "-v", id] : [kind, "rm", id],
          );
        });
      }
    });
  }
  for (const kind of ["container", "volume", "network"]) {
    await attempt(async () =>
      assert.deepEqual(
        await owned(docker, config.project, kind),
        [],
        `${kind} cleanup incomplete`,
      ),
    );
  }
  if (errors.length)
    throw new AggregateError(errors, `Cleanup failed for ${config.project}`);
  if (config.credentials) {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    assert.equal(
      config.credentials,
      resolve(
        root,
        "artifacts/verification/authenticated-e2e",
        config.project,
        "credentials",
      ),
    );
    rmSync(config.credentials, { recursive: true });
  }
}
