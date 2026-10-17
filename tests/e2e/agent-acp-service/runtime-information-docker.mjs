import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";

// CI's shard runner and the local coordinator retain stdout in durable private
// evidence. Preserve raw OTLP base64 records, including on a failed probe.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const probe = fileURLToPath(
  new URL("./runtime-information-probe.mjs", import.meta.url),
);
const toolsProbe = fileURLToPath(
  new URL("./runtime-tools-probe.mjs", import.meta.url),
);
const toolsEvidence = fileURLToPath(
  new URL("./runtime-tools-evidence.mjs", import.meta.url),
);
const upgradeProbe = fileURLToPath(
  new URL("./upgrade-lifecycle-probe.mjs", import.meta.url),
);
const token = randomUUID().slice(0, 12);
const container = `antnest-acp-read-${token}`;
const provided = process.env.ANTNEST_ACP_TEST_IMAGE;
const image = provided ?? `antnest-acp-read:${token}`;
assert(
  !process.env.ANTNEST_CI_PROVIDED_IMAGES || provided,
  "CI must provide its candidate ACP image",
);
assert(
  typeof image === "string" &&
    image.length > 0 &&
    !/^[\s-]|[\s\0]/u.test(image),
);
const controller = new AbortController();
const docker = dockerClient(process.env, controller.signal, 600000);
let interrupted = 0;
const interrupt = () => {
  interrupted ||= 130;
  controller.abort();
};
const terminate = () => {
  interrupted ||= 143;
  controller.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
let failure;
let buildAttempted = false;
let createAttempted = false;
let imageId;
try {
  if (!provided) {
    buildAttempted = true;
    await docker(
      [
        "build",
        "-q",
        "-f",
        `${root}services/agent-acp-service/Dockerfile`,
        "-t",
        image,
        root,
      ],
      true,
    );
  }
  imageId = (
    await docker(["image", "inspect", "--format", "{{.Id}}", image])
  ).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  createAttempted = true;
  await docker([
    "create",
    "--name",
    container,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=32m",
    "--entrypoint",
    "sh",
    "--mount",
    `type=bind,src=${probe},dst=/app/runtime-information-probe.mjs,readonly`,
    "--mount",
    `type=bind,src=${toolsProbe},dst=/app/runtime-tools-probe.mjs,readonly`,
    "--mount",
    `type=bind,src=${toolsEvidence},dst=/app/runtime-tools-evidence.mjs,readonly`,
    "--mount",
    `type=bind,src=${upgradeProbe},dst=/app/upgrade-lifecycle-probe.mjs,readonly`,
    imageId,
    "-c",
    "node /app/runtime-information-probe.mjs && node /app/runtime-tools-probe.mjs && node /app/upgrade-lifecycle-probe.mjs",
  ]);
  const before = JSON.parse(await docker(["inspect", container]))[0];
  assert.equal(before.Image, imageId);
  assert.equal(before.Config.User, "node");
  console.log(
    JSON.stringify({
      event: "runtime_information_image",
      image,
      image_id: imageId,
      container,
    }),
  );
  await docker(["start", "--attach", container], true, { timeoutMS: 150000 });
  const after = JSON.parse(await docker(["inspect", container]))[0];
  assert.equal(after.Image, imageId);
  assert.equal(after.State.Status, "exited");
  assert.equal(after.State.ExitCode, 0);
  assert.equal(after.State.OOMKilled, false);
  controller.signal.throwIfAborted();
} catch (error) {
  failure = error;
} finally {
  // Cleanup has its own deadline and is attempted even after interruption.
  const cleanup = dockerClient(process.env, undefined, 90000);
  const errors = [];
  if (createAttempted) {
    try {
      console.log(
        await cleanup(["logs", container], false, { captureStderr: true }),
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await cleanup(["rm", "--force", "--volumes", container]);
    } catch (error) {
      errors.push(error);
    }
  }
  if (buildAttempted) {
    try {
      const listed = (await cleanup(["image", "ls", "-q", image])).trim();
      if (listed) await cleanup(["image", "rm", image]);
    } catch (error) {
      errors.push(error);
    }
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  console.log(
    JSON.stringify({
      event: "runtime_information_cleanup",
      container,
      own_image_removed: buildAttempted && errors.length === 0,
      shared_image_preserved: Boolean(provided),
      failures: errors.length,
      interrupted,
    }),
  );
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "ACP provenance cleanup failed",
    );
}
if (interrupted || failure) {
  if (failure) console.error(failure);
  process.exitCode = interrupted || 1;
} else
  console.log(
    JSON.stringify({
      event: "runtime_information_docker_verified",
      image_id: imageId,
    }),
  );
