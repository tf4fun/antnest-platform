import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { discoverNetworkOctet } from "../acp-closeout/network.mjs";
import { dockerInvocation } from "../acp-closeout/docker.mjs";

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
  const image = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "antnest/antnest-runtime:local",
  ]);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const ports = new Set();
  while (ports.size < 4) ports.add(await freePort());
  const [pg, edge, jaeger, model] = [...ports];
  const gateway = `http://127.0.0.1:${edge}`;
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    ANTNEST_POSTGRES_HOST_PORT: String(pg),
    ANTNEST_EDGE_HOST_PORT: String(edge),
    ANTNEST_JAEGER_UI_HOST_PORT: String(jaeger),
    ANTNEST_LIFECYCLE_MODEL_HOST_PORT: String(model),
    ANTNEST_EDGE_PUBLIC_BASE_URL: gateway,
    ANTNEST_RUNTIME_CONTROLLER_SCOPE: project,
    ANTNEST_RUNTIME_MANAGEMENT_NETWORK: `${project}-runtime-management`,
    ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME: `${project}-system-skills`,
    ANTNEST_RUNTIME_MANAGEMENT_SUBNET: `10.243.${octet}.0/24`,
    ANTNEST_EGRESS_IPV4: `10.243.${octet}.3`,
    ANTNEST_JAEGER_RUNTIME_IPV4: `10.243.${octet}.4`,
    ANTNEST_EGRESS_CONTROL_SUBNET: `10.242.${octet}.0/24`,
    ANTNEST_EGRESS_CONTROL_IPV4: `10.242.${octet}.3`,
    ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT: `http://10.243.${octet}.4:4318`,
    ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: image,
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
}
