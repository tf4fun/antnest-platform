import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient, lines } from "../lifecycle-closeout/docker.mjs";
import { createProgressGateHost, runtimeGate } from "./gate.mjs";
import { cleanupProgressProbe } from "./gate-cleanup.mjs";
import {
  durablePath,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";

// Linux process/file probe acceptance only. The existing Runtime image supplies
// the shell and Node; its product entrypoint is deliberately not exercised.
// This fixture image alias is never a production-candidate admission record.
const directory = durablePath(process.argv[2]);
const imageID = process.argv[3];
assert.match(imageID ?? "", /^sha256:[a-f0-9]{64}$/u);
shellStoragePreflight(directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const run = randomUUID(),
  project = `antnest-stage3-e2e-${process.pid}`;
const agent = `agent_${run.replaceAll("-", "")}`;
const container = `antnest-runtime-${agent}`;
const image = `antnest/antnest-runtime:progress-${run}`;
const owner = "io.antnest.progress-gate-probe";
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  ANTNEST_E2E_RUN_ID: run,
  TEST_RUNTIME_IMAGE: image,
};
const controller = new AbortController();
const interrupt = () =>
  controller.abort(
    new Error("Progress gate container verification interrupted"),
  );
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const docker = dockerClient(env, controller.signal, 300000);
const save = (name, value) =>
  writeEvidenceFile(directory, name, JSON.stringify(value) + "\n");
const checks = [],
  errors = [];
let createAttempted = false,
  tagAttempted = false,
  baseline,
  containerID;
const snapshot = async (runDocker) => {
  const value = {};
  for (const [key, args] of [
    ["containers", ["container", "ls", "-aq", "--no-trunc"]],
    ["networks", ["network", "ls", "-q", "--no-trunc"]],
    ["volumes", ["volume", "ls", "-q"]],
    [
      "images",
      [
        "image",
        "ls",
        "--no-trunc",
        "--format",
        "{{.Repository}}:{{.Tag}} {{.ID}}",
      ],
    ],
  ])
    value[key] = (await runDocker(args)).split("\n").filter(Boolean).sort();
  return value;
};
const fixture = String.raw`
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const children = new Map();
for (const phase of ["v1-bash-cancel", "v2-bash-cancel", "v1-bash-success"]) {
  const child = spawn("/bin/sh", ["-c", "echo $$ > /workspace/" + phase + "-pid; while [ ! -e /workspace/" + phase + "-release ]; do sleep 0.1; done"], { stdio: "ignore" });
  children.set(phase, child);
  child.once("exit", () => { children.delete(phase); writeFileSync("/workspace/" + phase + "-reaped", "reaped\n"); });
}
for (const phase of ["v1-managed-cancel", "v2-managed-cancel"]) writeFileSync("/workspace/" + phase + "-started", "started\n");
setInterval(() => {
  for (const [phase, child] of children) if (existsSync("/workspace/" + phase + "-stop")) child.kill("SIGTERM");
}, 25);
writeFileSync("/workspace/ready", "ready\n");
`;
const execute = (script, user = "1000:1000") =>
  docker(["exec", "--user", user, container, "/bin/sh", "-c", script]);
const waitFile = async (file) => {
  assert.match(file, /^[a-zA-Z0-9-]+$/u);
  const end = performance.now() + 10000;
  for (;;) {
    const status = await execute(
      `if test -s /workspace/${file}; then printf ready; else printf pending; fi`,
    );
    if (status === "ready") return;
    assert.equal(status, "pending");
    assert(performance.now() < end, "Linux process fixture deadline");
    await delay(25, undefined, { signal: controller.signal });
  }
};
async function gate(label) {
  const channel = join(directory, label, "channel"),
    evidence = join(directory, label, "host");
  const host = createProgressGateHost({
    env,
    directory: channel,
    evidence,
    imageID,
    docker,
  });
  return runtimeGate(agent, {
    env,
    directory: channel,
    signal: controller.signal,
    wait: async () => {
      await host.poll(controller.signal);
    },
  });
}
try {
  baseline = await snapshot(docker);
  save("baseline.json", baseline);
  const actualImage = JSON.parse(await docker(["image", "inspect", imageID]));
  assert.equal(actualImage.length, 1);
  assert.equal(actualImage[0].Id, imageID);
  save("probe-image.json", {
    original: actualImage,
    alias: image,
    probe_only: true,
    product_runtime_entrypoint_exercised: false,
    runtime_candidate_admitted: false,
  });
  assert(!baseline.images.some((row) => row.startsWith(image + " ")));
  tagAttempted = true;
  await docker(["image", "tag", imageID, image]);
  createAttempted = true;
  containerID = await docker([
    "run",
    "--detach",
    "--pull",
    "never",
    "--name",
    container,
    "--label",
    `${owner}=${run}`,
    "--label",
    `io.antnest.agent-id=${agent}`,
    "--label",
    "io.antnest.managed=runtime",
    "--label",
    `io.antnest.runtime-controller-scope=${project}`,
    "--label",
    "io.antnest.runtime-generation=1",
    "--env",
    `ANTNEST_RUNTIME_IMAGE_REFERENCE=${image}`,
    "--env",
    `ANTNEST_RUNTIME_IMAGE_ID=${imageID}`,
    "--user",
    "1000:1000",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/workspace:rw,uid=1000,gid=1000,mode=0700",
    "--no-healthcheck",
    "--entrypoint",
    "node",
    imageID,
    "--input-type=module",
    "-e",
    fixture,
  ]);
  assert.match(containerID, /^[a-f0-9]{64}$/u);
  await waitFile("ready");
  await waitFile("v1-bash-cancel-pid");
  const positive = await gate("positive");
  await positive.alive("v1-bash-cancel", "bash");
  assert.equal(await positive.stopped("v1-bash-cancel", "bash"), false);
  checks.push("bound Bash PID/start_ticks remains pending while alive");
  await execute("touch /workspace/v1-bash-cancel-stop");
  await waitFile("v1-bash-cancel-reaped");
  assert.equal(await positive.stopped("v1-bash-cancel", "bash"), true);
  checks.push("original Bash PID stopped after its owning parent reaped it");
  await positive.release("v1-bash-success");
  await waitFile("v1-bash-success-reaped");
  checks.push("release actually unblocks and joins the waiting child");
  await positive.alive("v1-managed-cancel", "managed");
  assert.equal(await positive.stopped("v1-managed-cancel", "managed"), false);
  await execute("printf canceled > /workspace/v1-managed-cancel-canceled");
  assert.equal(await positive.stopped("v1-managed-cancel", "managed"), true);
  checks.push("managed marker pending/stopped distinction");
  await waitFile("v2-bash-cancel-pid");
  const replaced = await gate("replaced-pid");
  await replaced.alive("v2-bash-cancel", "bash");
  await execute("printf 999999 > /workspace/v2-bash-cancel-pid");
  await assert.rejects(replaced.stopped("v2-bash-cancel", "bash"));
  checks.push("replacing PID file with an absent PID cannot report stopped");
  const empty = await gate("empty-marker");
  await empty.alive("v2-managed-cancel", "managed");
  await execute(": > /workspace/v2-managed-cancel-canceled");
  await assert.rejects(empty.stopped("v2-managed-cancel", "managed"));
  checks.push("empty cancellation marker rejected");
  // All capabilities were dropped, so UID 0 cannot bypass the fixture's file
  // permissions. Explicitly permit this one controlled negative-case setup.
  await execute(
    "chmod 0777 /workspace; chmod 0666 /workspace/v1-bash-cancel-pid",
  );
  await docker([
    "exec",
    "--detach",
    "--user",
    "0:0",
    container,
    "/bin/sh",
    "-c",
    "echo $$ > /workspace/v1-bash-cancel-pid || exit 2; printf ready > /workspace/root-ready || exit 2; while :; do sleep 1; done",
  ]);
  await waitFile("root-ready");
  const rootPID = await execute("cat /workspace/v1-bash-cancel-pid");
  assert.match(rootPID, /^[1-9]\d*$/u);
  assert(Number(rootPID) > 1);
  const status = await execute(`cat /proc/${rootPID}/status`);
  assert.match(status, /^Uid:\s+0\s+0\s+0\s+0$/mu);
  writeEvidenceFile(directory, "root-process-status.txt", status + "\n");
  const own = await execute(`kill -0 ${rootPID} && printf allowed`, "0:0");
  const other = await execute(
    `if kill -0 ${rootPID} 2>/dev/null; then printf allowed; elif test -d /proc/${rootPID}; then printf denied; else printf gone; fi`,
  );
  assert.equal(own, "allowed");
  assert.equal(other, "denied");
  save("root-process-permissions.json", {
    pid: Number(rootPID),
    uid: 0,
    owner_probe: own,
    uid_1000_probe: other,
  });
  const permission = await gate("permission-denied");
  await assert.rejects(permission.alive("v1-bash-cancel", "bash"));
  checks.push("UID 1000 cannot approve an inaccessible root process");
} catch (error) {
  errors.push(error);
} finally {
  const cleanup = dockerClient(process.env, undefined, 90000);
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  if (createAttempted)
    await attempt(() =>
      cleanupProgressProbe({
        run,
        containerID,
        docker: cleanup,
        save: (file, raw) => writeEvidenceFile(directory, file, raw),
      }),
    );
  if (tagAttempted)
    await attempt(async () => {
      const found = lines(
        await cleanup(["image", "ls", "--quiet", "--no-trunc", image]),
      );
      if (found.length) {
        assert.deepEqual(found, [imageID]);
        await cleanup(["image", "rm", image]);
      }
    });
  await attempt(async () => {
    const after = await snapshot(cleanup);
    save("after.json", after);
    if (baseline)
      assert.deepEqual(
        after,
        baseline,
        "Docker resources differ after probe verification",
      );
  });
  save("result.json", {
    status: errors.length ? "failed" : "passed",
    checks,
    scope:
      "Linux fixed probes and file IPC only; no MCP cancellation, product Runtime or Progress business admission",
    image_id: imageID,
    probe_alias: image,
    project,
    run_id: run,
    agent_id: agent,
    errors: errors.map((error) => ({
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    })),
  });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
console.log(
  JSON.stringify({
    status: errors.length ? "failed" : "passed",
    checks: checks.length,
    scope: "Progress Linux gate probes",
  }),
);
if (errors.length) process.exitCode = 1;
