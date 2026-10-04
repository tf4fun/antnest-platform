import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { provisionTokens } from "../../../scripts/dev-service-tokens.mjs";
import {
  dockerClient,
  networkOctet,
  owned,
  scopeLabel,
} from "../../e2e/lifecycle-closeout/docker.mjs";
import { durablePath } from "../../support/storage.mjs";
import { runCommand } from "../../support/run-command.mjs";
import { queryJaeger, jaegerTraceSpans } from "../../support/jaeger-api.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/platform/development-authentication-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const topology = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/platform/development-network-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const project = `antnest-deployment-${randomUUID().slice(0, 8)}`;
const tag = `authentication-${project.slice(-8)}`;
const output = durablePath(resolve(root, "artifacts/verification", project));
const credentials = resolve(output, "credentials");
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(key),
  ),
);
const docker = dockerClient(env, controller.signal, 1800000);
const compose = [
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
  resolve(root, "tests/integration/deployment/compose.admission.yaml"),
  "--profile",
  "stage3",
  "--profile",
  "observability",
];
const services = Object.keys(contract.static_services);
const built = [];
const report = {
  project,
  scope: "actual-compose-deployment",
  checks: 0,
  cleanup: false,
};
let stage = "preparing",
  failure;
mkdirSync(output, { recursive: true, mode: 0o700 });
function save(name, data) {
  writeFileSync(resolve(output, name), `${JSON.stringify(data)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
async function phase(name, action) {
  stage = name;
  console.log(JSON.stringify({ stage, status: "running" }));
  await action();
  console.log(JSON.stringify({ stage, status: "passed" }));
}
async function identities(client) {
  const result = {};
  for (const [kind, args] of [
    ["container", ["ps", "-aq"]],
    ["network", ["network", "ls", "-q"]],
    ["volume", ["volume", "ls", "-q"]],
  ])
    result[kind] = (await client(args)).split(/\s+/u).filter(Boolean).sort();
  return result;
}
async function freePort() {
  const listener = createServer();
  try {
    await new Promise((done, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", done);
    });
    return listener.address().port;
  } finally {
    await new Promise((done, reject) =>
      listener.close((error) => (error ? reject(error) : done())),
    );
  }
}
async function http(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
  });
  const body = await response.json();
  return { status: response.status, body };
}
let before, rows;
try {
  before = await identities(docker);
  await phase("prepare", async () => {
    provisionTokens({ output: credentials, withSkillLearning: true });
    const octet = await networkOctet(docker, 1 + (process.pid % 200));
    const gatewayPort = await freePort();
    Object.assign(
      env,
      parseEnv(readFileSync(resolve(credentials, "deployment.env"), "utf8")),
      {
        COMPOSE_PROJECT_NAME: project,
        ANTNEST_ADMISSION_TAG: tag,
        ANTNEST_SERVICE_NETWORK_PREFIX: `10.242.${octet}`,
        ANTNEST_RUNTIME_CONTROLLER_SCOPE: project,
        ANTNEST_RUNTIME_MANAGEMENT_NETWORK: `${project}-management`,
        ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME: `${project}-system-skills`,
        ANTNEST_RUNTIME_MANAGEMENT_SUBNET: `10.243.${octet}.128/25`,
        ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE: `10.243.${octet}.192/26`,
        ANTNEST_EGRESS_IPV4: `10.243.${octet}.131`,
        ANTNEST_RUNTIME_OTLP_INGRESS_IPV4: `10.243.${octet}.132`,
        ANTNEST_RUNTIME_CONTROLLER_MANAGEMENT_IPV4: `10.243.${octet}.133`,
        ANTNEST_ACP_MANAGEMENT_IPV4: `10.243.${octet}.134`,
        ANTNEST_EGRESS_CONTROL_SUBNET: `10.243.${octet}.0/25`,
        ANTNEST_EGRESS_CONTROL_IPV4: `10.243.${octet}.3`,
        ANTNEST_AGENT_CONTROLLER_CONTROL_IPV4: `10.243.${octet}.4`,
        ANTNEST_EDGE_HOST_PORT: String(gatewayPort),
        ANTNEST_EDGE_PUBLIC_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
        ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG: "deployment-admission",
        ANTNEST_BOOTSTRAP_ORGANIZATION_NAME: "Deployment admission",
        ANTNEST_BOOTSTRAP_ADMIN_EMAIL: "deployment@example.com",
        ANTNEST_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
        ANTNEST_IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY:
          randomBytes(32).toString("base64"),
        ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
        OTEL_SDK_DISABLED: "false",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
      },
    );
    for (const { environment } of Object.values(
      contract.host_ports.debug_publications,
    ))
      env[environment] = "0";
  });
  for (const service of [...services, "temporal"])
    await phase(`build-${service}`, async () => {
      const image = `antnest/${service}:${tag}`;
      assert.equal(
        await docker(["image", "ls", "-q", image]),
        "",
        "isolated image tag already exists",
      );
      built.push(image);
      await docker([...compose, "build", service], true);
    });
  await phase("startup", async () => {
    await docker(
      [
        ...compose,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-build",
        "--pull",
        "never",
      ],
      true,
    );
    const ids = (await docker([...compose, "ps", "-q"]))
      .split(/\s+/u)
      .filter(Boolean);
    rows = JSON.parse(await docker(["inspect", ...ids]));
    const names = rows.map(
      (row) => row.Config.Labels["com.docker.compose.service"],
    );
    assert.deepEqual(
      names.sort(),
      [
        ...services,
        "postgres",
        "temporal",
        "jaeger",
        "diagnostic-relay",
        "runtime-telemetry-ingress",
      ].sort(),
    );
    for (const row of rows) {
      assert.equal(row.Config.Labels["com.docker.compose.project"], project);
      assert.equal(row.State.Running, true);
      if (row.Config.Labels["com.docker.compose.service"] !== "jaeger")
        assert.equal(row.State.Health?.Status, "healthy");
      report.checks++;
    }
  });
  await phase("private-mounts-and-listeners", async () => {
    for (const service of services) {
      const row = rows.find(
        (item) => item.Config.Labels["com.docker.compose.service"] === service,
      );
      const settings = Object.fromEntries(
        row.Config.Env.map((entry) => {
          const index = entry.indexOf("=");
          return [entry.slice(0, index), entry.slice(index + 1)];
        }),
      );
      assert.equal(settings.ANTNEST_SERVICE_AUTH_MODE, "token");
      assert.equal(
        settings.ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT,
        "true",
      );
      for (const file of ["callers.json", "tokens"]) {
        const mount = row.Mounts.find(
          (item) => item.Destination === `/etc/antnest/service-auth/${file}`,
        );
        assert(
          mount &&
            mount.Source === resolve(credentials, service, file) &&
            mount.RW === false,
          "private owner mount differs",
        );
      }
      assert(
        !row.Mounts.some((item) => item.Source === credentials),
        "full credential root is mounted",
      );
      if (!["runtime-controller", "runtime-egress"].includes(service))
        assert.equal(
          row.Config.User,
          `${env.ANTNEST_SERVICE_AUTH_UID}:${env.ANTNEST_SERVICE_AUTH_GID}`,
        );
      for (const [network, item] of Object.entries(topology.networks).filter(
        ([, item]) => service in item.members,
      ))
        assert.equal(
          row.NetworkSettings.Networks[`${project}_${network}`].IPAddress,
          network === "control"
            ? env[
                service === "runtime-egress"
                  ? "ANTNEST_EGRESS_CONTROL_IPV4"
                  : "ANTNEST_AGENT_CONTROLLER_CONTROL_IPV4"
              ]
            : `${env.ANTNEST_SERVICE_NETWORK_PREFIX}.${item.members[service]}`,
        );
      report.checks++;
    }
    for (const name of ["diagnostic-relay", "runtime-telemetry-ingress"]) {
      const row = rows.find(
        (item) => item.Config.Labels["com.docker.compose.service"] === name,
      );
      assert.equal(row.Config.User, "65532:65532");
      assert.equal(row.HostConfig.ReadonlyRootfs, true);
      assert(
        row.Mounts.every(
          (item) => !item.RW && !item.Source.startsWith(credentials),
        ),
      );
      report.checks++;
    }
  });
  const relay = rows.find(
    (item) =>
      item.Config.Labels["com.docker.compose.service"] === "diagnostic-relay",
  );
  const endpoint = (service) => {
    const target = topology.infrastructure.diagnostics.listener_ports[service];
    const bindings = relay.NetworkSettings.Ports[`${target}/tcp`];
    assert.equal(bindings?.length, 1);
    assert.equal(bindings[0].HostIp, "127.0.0.1");
    return `http://127.0.0.1:${bindings[0].HostPort}`;
  };
  await phase("authenticated-diagnostics", async () => {
    for (const service of [
      "identity-service",
      "agent-controller",
      "runtime-controller",
      "agent-acp-service",
    ]) {
      const routes = JSON.parse(
        readFileSync(resolve(root, contract.static_services[service]), "utf8"),
      ).routes;
      const pattern = Object.keys(routes).find(
        (key) =>
          /^(?:GET|POST) /u.test(key) &&
          routes[key].authentication === "workload",
      );
      assert(pattern, "no workload probe route");
      const [method, path] = pattern.split(" ");
      const response = await http(
        endpoint(service) +
          path.replace(/\{[^}]+\}/gu, "00000000-0000-4000-8000-000000000001"),
        {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        },
      );
      assert.equal(response.status, 401, `${service} unauthorized diagnostic`);
      report.checks++;
    }
    const token = readFileSync(
      resolve(credentials, "edge-gateway/tokens/identity-service"),
      "ascii",
    );
    const response = await http(
      endpoint("identity-service") + "/rpc/identity/jwks",
      { headers: { "Antnest-Service-Authorization": `Bearer ${token}` } },
    );
    assert.equal(response.status, 200);
    assert(
      response.body.keys.some(
        (key) => key.kid === env.ANTNEST_IDENTITY_CCT_SIGNING_KID,
      ),
      "configured CCT key is absent",
    );
    report.checks++;
    const collector = await queryJaeger(endpoint("jaeger"), "services", {
      signal: controller.signal,
    });
    assert.equal(collector.status, 200);
    assert(Array.isArray(collector.body?.services ?? []));
    report.checks++;
  });
  await phase("actual-jaeger-otlp", async () => {
    const telemetry = JSON.parse(
      await docker([
        "run",
        "--rm",
        "--name",
        `${project}-telemetry-probe`,
        "--label",
        `com.docker.compose.project=${project}`,
        "--network",
        env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "65532:65532",
        "--mount",
        `type=bind,src=${resolve(root, "tests/integration/deployment/fixtures/compose-telemetry-probe.mjs")},dst=/probe.mjs,readonly`,
        "--env",
        `ANTNEST_PROBE_OTLP=${env.ANTNEST_RUNTIME_OTLP_INGRESS_IPV4}`,
        "--env",
        `ANTNEST_PROBE_RC=${env.ANTNEST_RUNTIME_CONTROLLER_MANAGEMENT_IPV4}`,
        "--env",
        `ANTNEST_PROBE_ACP=${env.ANTNEST_ACP_MANAGEMENT_IPV4}`,
        "node:24.21.0-bookworm-slim",
        "node",
        "/probe.mjs",
      ]),
    );
    assert.match(telemetry.trace_id, /^[a-f0-9]{32}$/u);
    assert.equal(telemetry.checks, 5);
    report.checks += telemetry.checks;
    let found = false;
    let captured = false;
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      const response = await queryJaeger(
        endpoint("jaeger"),
        `traces/${telemetry.trace_id}`,
        { signal: controller.signal },
      );
      if (response.status === 200 && !captured) {
        save("telemetry-trace.json", response.body);
        captured = true;
      }
      found =
        response.status === 200 &&
        jaegerTraceSpans(response.body, telemetry.trace_id).some(
          (span) => span.name === "deployment.otlp.ingest",
        );
      if (!found) await delay(250, undefined, { signal: controller.signal });
    }
    assert.equal(
      found,
      true,
      "management OTLP span was not found in actual Jaeger",
    );
    report.checks++;
  });
  await phase("normal-stop", async () => {
    await docker([...compose, "stop", "--timeout", "30"], true);
    const stopped = JSON.parse(
      await docker(["inspect", ...rows.map((row) => row.Id)]),
    );
    for (const row of stopped) {
      assert.equal(row.State.Running, false);
      assert.equal(
        row.State.ExitCode,
        0,
        `${row.Config.Labels["com.docker.compose.service"]} normal stop`,
      );
      report.checks++;
    }
  });
} catch (error) {
  failure = error;
  save("failure.json", {
    stage,
    error_type: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Failure",
  });
} finally {
  const cleanup = dockerClient(env, undefined, 300000);
  const errors = [];
  try {
    for (const id of await owned(cleanup, project, "container")) {
      const row = JSON.parse(await cleanup(["inspect", id]))[0];
      const name = row.Config.Labels["com.docker.compose.service"] ?? "runtime";
      const log = await runCommand({
        command: ["docker", "logs", "--tail", "500", id],
        env,
        cwd: root,
        output,
        name: `${name}-container`,
        timeoutMs: 10000,
        graceMs: 5000,
      });
      assert.equal(log.exit_code, 0, "container log capture failed");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (env.ANTNEST_ADMISSION_TAG)
      await cleanup(
        [
          ...compose,
          "down",
          "--volumes",
          "--remove-orphans",
          "--timeout",
          "30",
        ],
        true,
      );
    for (const kind of ["container", "volume", "network"]) {
      for (const id of await owned(cleanup, project, kind)) {
        const row = JSON.parse(
          await cleanup(
            kind === "container" ? ["inspect", id] : [kind, "inspect", id],
          ),
        )[0];
        const labels = kind === "container" ? row.Config.Labels : row.Labels;
        assert(
          [labels["com.docker.compose.project"], labels[scopeLabel]]
            .filter(Boolean)
            .every((value) => value === project),
          "conflicting cleanup ownership",
        );
        await cleanup(
          kind === "container" ? ["rm", "-f", "-v", id] : [kind, "rm", id],
        );
      }
      assert.deepEqual(await owned(cleanup, project, kind), []);
    }
    for (const image of built) {
      if (await cleanup(["image", "ls", "-q", image])) {
        assert.equal(
          await cleanup([
            "image",
            "inspect",
            "--format",
            '{{index .Config.Labels "io.antnest.deployment-admission"}}',
            image,
          ]),
          project,
        );
        await cleanup(["image", "rm", image]);
      }
    }
    rmSync(credentials, { recursive: true, force: true });
    if (before)
      assert.deepEqual(
        await identities(cleanup),
        before,
        "retained Docker resources differ",
      );
    report.cleanup = true;
  } catch (error) {
    errors.push(error);
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  if (errors.length)
    failure ??= new AggregateError(errors, "Deployment cleanup failed");
  save("result.json", {
    ...report,
    status: failure ? "failed" : "passed",
    last_stage: stage,
  });
}
console.log(
  JSON.stringify({
    ...report,
    status: failure ? "failed" : "passed",
    last_stage: stage,
  }),
);
if (failure) process.exitCode = 1;
