import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fixtureEnvironment,
  prepareFixtureCredentials,
} from "./authenticated-e2e.mjs";
import { runCommand } from "./run-command.mjs";
import { evidenceDirectory, writeEvidenceFile } from "./storage.mjs";
import { prepareEgressOwnership } from "../../scripts/dev-egress-auth-owner.mjs";
import {
  cleanup,
  dockerClient,
  networkOctet,
  lines,
} from "../e2e/lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const owners = [
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
];
const entrypoints = {
  stage1: ["sh", "tests/e2e/e2e-stage1.sh"],
  stage2: ["sh", "tests/e2e/e2e-stage2.sh"],
  "runtime-controller": ["sh", "tests/e2e/runtime-controller/run.sh"],
  lifecycle: ["node", "tests/e2e/lifecycle-closeout/run.mjs"],
};

export function shellComposeFiles(profile) {
  assert(
    ["stage1", "stage2", "runtime-controller", "lifecycle"].includes(profile),
  );
  return [
    "compose.yaml",
    ...(profile === "stage1" ? [] : ["compose.debug.yaml"]),
    ...(profile === "stage2" ? ["tests/e2e/stage2.compose.yaml"] : []),
    "tests/integration/deployment/compose.admission.yaml",
  ];
}

export function shellFixtureEnvironment({
  inherited,
  project,
  octet,
  authentication,
  tag,
  runtimeImage,
}) {
  return {
    ...fixtureEnvironment(inherited, { project, octet }),
    ...authentication,
    COMPOSE_ENV_FILES: ".env.example",
    ANTNEST_ADMISSION_TAG: tag,
    ANTNEST_E2E_CANDIDATE_TAG: tag,
    ANTNEST_E2E_RUNTIME_IMAGE: runtimeImage,
    ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: runtimeImage,
    ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE: `10.243.${octet}.128/25`,
  };
}

async function freePort() {
  const server = createServer();
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    return server.address().port;
  } finally {
    await new Promise((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}

async function identities(docker) {
  const result = {};
  for (const [name, args] of [
    ["containers", ["ps", "-aq"]],
    ["volumes", ["volume", "ls", "-q"]],
    ["networks", ["network", "ls", "-q"]],
  ])
    result[name] = lines(await docker(args)).sort();
  return result;
}

export async function runShellAcceptance(profile) {
  assert(Object.hasOwn(entrypoints, profile));
  const project = "antnest-lifecycle-" + randomUUID().slice(0, 8);
  const tag = "shell-" + project.slice(-8);
  const runtimeImage = "antnest/antnest-runtime:" + tag;
  const output = evidenceDirectory(
    `artifacts/verification/shell-${profile}/${project}`,
  );
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(name),
    ),
  );
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("shell acceptance interrupted"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  const docker = dockerClient(inherited, abort.signal, 1800000);
  const built = [];
  let config, before, result, cleaned;
  const failures = [];
  try {
    before = await identities(docker);
    const octet = await networkOctet(docker, 1 + (process.pid % 200));
    const prepared = prepareFixtureCredentials(project, root);
    const env = shellFixtureEnvironment({
      inherited,
      project,
      octet,
      authentication: prepared.environment,
      tag,
      runtimeImage,
    });
    config = { project, env, credentials: prepared.credentials };
    await prepareEgressOwnership(docker, prepared.credentials);
    const ports = new Set();
    while (ports.size < 10) ports.add(await freePort());
    for (const [index, name] of [
      "POSTGRES",
      "RUNTIME_CONTROLLER",
      "ACP",
      "AGENT_CONTROLLER",
      "JAEGER_UI",
      "IDENTITY",
      "STAGE2_MODEL",
      "STAGE2_OTLP",
      "TEMPORAL",
      "EDGE",
    ].entries())
      env[`ANTNEST_${name}_HOST_PORT`] = String([...ports][index]);
    env.ANTNEST_EDGE_PUBLIC_BASE_URL = `http://127.0.0.1:${env.ANTNEST_EDGE_HOST_PORT}`;
    env.COMPOSE_FILE = shellComposeFiles(profile).join(":");
    const selected =
      profile === "stage1"
        ? ["runtime-egress"]
        : profile === "runtime-controller"
          ? ["runtime-egress", "runtime-controller"]
          : owners;
    for (const service of ["antnest-runtime", ...selected]) {
      abort.signal.throwIfAborted();
      const image = "antnest/" + service + ":" + tag;
      assert.equal(
        await docker(["image", "ls", "-q", image]),
        "",
        "candidate already exists",
      );
      built.push(image);
      const command =
        service === "antnest-runtime"
          ? [
              "docker",
              "build",
              "-f",
              "runtimes/antnest-runtime/Dockerfile",
              "-t",
              image,
              ".",
            ]
          : [
              "docker",
              "compose",
              "--profile",
              "stage3",
              "--profile",
              "observability",
              "build",
              service,
            ];
      const gate = await runCommand({
        command,
        cwd: root,
        env,
        output,
        name: "build-" + service,
        // A cold Runtime release build on a 2-core CI runner can exceed 10 min.
        timeoutMs: 1800000,
      });
      assert.equal(gate.exit_code, 0, "candidate build failed: " + service);
    }
    abort.signal.throwIfAborted();
    console.log(JSON.stringify({ profile, project, stage: "business" }));
    result = await runCommand({
      command: entrypoints[profile],
      cwd: root,
      env,
      output,
      name: "business",
      timeoutMs: 1200000,
    });
    assert.equal(result.exit_code, 0, "business failed; see private evidence");
  } catch (error) {
    failures.push(error);
    writeEvidenceFile(
      output,
      "failure.private.txt",
      error.stack ?? String(error),
    );
  } finally {
    const failuresBeforeCleanup = failures.length;
    try {
      if (config) await cleanup(config);
    } catch (error) {
      failures.push(error);
    }
    const cleaning = dockerClient(inherited, undefined, 180000);
    for (const image of built.reverse()) {
      try {
        if (await cleaning(["image", "ls", "-q", image]))
          await cleaning(["image", "rm", image]);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (before)
        assert.deepEqual(
          await identities(cleaning),
          before,
          "retained Docker identities changed",
        );
    } catch (error) {
      failures.push(error);
    }
    cleaned = failures.length === failuresBeforeCleanup;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.removeListener(signal, stop);
  }
  const report = {
    profile,
    project,
    exit_code: failures.length ? 1 : 0,
    business_exit_code: result?.exit_code ?? null,
    cleanup: cleaned ? "verified" : "failed",
    evidence: output,
  };
  writeEvidenceFile(output, "result.json", JSON.stringify(report));
  console.log(JSON.stringify(report));
  if (failures.length)
    throw new AggregateError(failures, "shell acceptance failed");
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error("one disposable acceptance profile required");
  await runShellAcceptance(process.argv[2]);
}
