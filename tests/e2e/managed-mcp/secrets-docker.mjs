import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuration,
  dockerClient,
  cleanup,
  lines,
} from "../lifecycle-closeout/docker.mjs";
import { configureFoundation } from "../lifecycle-closeout/foundation-setup.mjs";
import { applicationServices } from "../lifecycle-closeout/deployment.mjs";
import { runCommand } from "../../support/run-command.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { parseVersion } from "./protocol.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const version = parseVersion(process.argv[2]);
const tag = "shell-" + randomUUID().slice(0, 8);
const output = evidenceDirectory(
  `artifacts/verification/managed-mcp-secrets/v${version}-${tag}`,
);
const buildImage = `antnest/antnest-runtime:${tag}-build`,
  baseImage = `antnest/antnest-runtime:${tag}-base`,
  image = `antnest/antnest-runtime:${tag}`;
const abort = new AbortController();
const stop = () => abort.abort(new Error("managed MCP acceptance interrupted"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
const timer = setTimeout(stop, 1800000);
const docker = dockerClient(process.env, abort.signal, 1800000);
const built = [],
  failures = [];
let config,
  before,
  business,
  cleaned = false;
async function identities(client) {
  const result = {};
  for (const [kind, args] of [
    ["containers", ["ps", "-aq"]],
    ["volumes", ["volume", "ls", "-q"]],
    ["networks", ["network", "ls", "-q"]],
  ])
    result[kind] = lines(await client(args)).sort();
  return result;
}
const gate = async (name, command, env = process.env) => {
  abort.signal.throwIfAborted();
  const result = await runCommand({
    name,
    command,
    env,
    cwd: root,
    output,
    timeoutMs: 1200000,
  });
  assert.equal(result.exit_code, 0, `${name} failed; see private evidence`);
};
try {
  before = await identities(docker);
  for (const candidate of [
    buildImage,
    baseImage,
    image,
    ...[...applicationServices, "temporal"].map(
      (service) => `antnest/${service}:${tag}`,
    ),
  ]) {
    assert.equal(
      await docker(["image", "ls", "-q", candidate]),
      "",
      "candidate tag already exists",
    );
    built.push(candidate);
  }
  console.log(JSON.stringify({ version, tag, stage: "build-runtime" }));
  await gate("build-runtime-fixture", [
    "docker",
    "build",
    "--target",
    "build",
    "-f",
    "runtimes/antnest-runtime/Dockerfile",
    "-t",
    buildImage,
    ".",
  ]);
  await gate("build-runtime", [
    "docker",
    "build",
    "-f",
    "runtimes/antnest-runtime/Dockerfile",
    "-t",
    baseImage,
    ".",
  ]);
  await gate("build-managed-runtime", [
    "docker",
    "build",
    "-f",
    "tests/e2e/managed-mcp/Dockerfile",
    "--build-arg",
    `RUNTIME_BUILD_IMAGE=${buildImage}`,
    "--build-arg",
    `RUNTIME_IMAGE=${baseImage}`,
    "-t",
    image,
    ".",
  ]);
  config = await configuration(abort.signal, () => {}, image);
  config.env.ANTNEST_ADMISSION_TAG = tag;
  configureFoundation(config);
  const compose = config.compose;
  config.compose = (args) =>
    compose(["-f", "tests/e2e/managed-mcp/secrets.compose.yaml", ...args]);
  const invoke = dockerClient(config.env, abort.signal, 1800000);
  for (const service of [...applicationServices, "temporal"]) {
    console.log(
      JSON.stringify({ version, tag, stage: "build-service", service }),
    );
    await gate(
      "build-" + service,
      ["docker", ...config.compose(["build", service])],
      config.env,
    );
  }
  console.log(
    JSON.stringify({ version, project: config.project, stage: "business" }),
  );
  await invoke(
    config.compose([
      "up",
      "-d",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "180",
    ]),
    true,
  );
  const relayID = await invoke(
    config.compose(["ps", "-q", "diagnostic-relay"]),
  );
  const [relay] = JSON.parse(await invoke(["inspect", relayID]));
  const rcPort = relay.NetworkSettings.Ports["58080/tcp"][0];
  assert.equal(rcPort.HostIp, "127.0.0.1");
  await gate(
    "business",
    [process.execPath, "tests/e2e/managed-mcp/client-entry.mjs"],
    {
      ...config.env,
      TEST_ACP_VERSION: String(version),
      TEST_RUNTIME_IMAGE: config.image,
      TEST_GATEWAY_URL: config.gateway,
      TEST_MODEL_URL: config.model,
      TEST_JAEGER_URL: config.jaeger,
      TEST_RUNTIME_CONTROLLER_URL: `http://127.0.0.1:${rcPort.HostPort}`,
      TEST_RC_TOKEN_FILE: resolve(
        config.credentials,
        "agent-controller/tokens/runtime-controller",
      ),
      TEST_EVIDENCE_DIRECTORY: output,
    },
  );
  business = JSON.parse(readFileSync(resolve(output, "business.json"), "utf8"));
  assert.equal(business.status, "business_passed");
  assert.equal(business.deleted, true);
  for (const args of [
    ["ps", "-aq"],
    ["volume", "ls", "-q"],
  ])
    assert.equal(
      await invoke([
        ...args,
        "--filter",
        `label=io.antnest.runtime-controller-scope=${config.project}`,
      ]),
      "",
      "deleted Agent retained a Runtime resource",
    );
} catch (error) {
  failures.push(error);
  writeEvidenceFile(
    output,
    "failure.private.txt",
    error.stack ?? String(error),
  );
  if (config)
    await runCommand({
      name: "diagnostics",
      command: [
        "docker",
        ...config.compose(["logs", "--no-color", "--tail", "100"]),
      ],
      env: config.env,
      cwd: root,
      output,
      timeoutMs: 30000,
    }).catch(() => {});
} finally {
  clearTimeout(timer);
  const priorFailures = failures.length;
  const cleaning = dockerClient(config?.env ?? process.env, undefined, 180000);
  try {
    if (config) await cleanup(config, cleaning);
  } catch (error) {
    failures.push(error);
  }
  for (const candidate of built.reverse()) {
    try {
      if (await cleaning(["image", "ls", "-q", candidate]))
        await cleaning(["image", "rm", candidate]);
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
  cleaned = failures.length === priorFailures;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.removeListener(signal, stop);
}
const result = {
  version,
  project: config?.project,
  complete: failures.length === 0,
  cleaned,
  business,
  evidence: output,
};
writeEvidenceFile(output, "result.json", JSON.stringify(result));
console.log(JSON.stringify(result));
if (failures.length)
  throw new AggregateError(
    failures,
    "managed MCP secrets acceptance failed; see private evidence",
  );
