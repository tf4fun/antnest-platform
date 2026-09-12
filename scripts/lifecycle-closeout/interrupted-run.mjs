import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { configuration, dockerClient, cleanup } from "./docker.mjs";
import {
  interruptionCompose,
  removeTestImages,
} from "./interruption-support.mjs";
import { runInterruptedUpdate } from "./interrupted-flow.mjs";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error("Interrupted-update profile interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 900000);
let config;
let imageTag;
let baseTag;
let result;
try {
  config = await configuration(abort.signal);
  const docker = dockerClient(config.env, abort.signal);
  imageTag = `antnest/lifecycle-update:${config.project}`;
  baseTag = `antnest/lifecycle-base:${config.project}`;
  console.error(`Disposable interrupted-update project: ${config.project}`);
  await docker(["tag", config.image, baseTag]);
  await docker(
    [
      "build",
      "--build-arg",
      `RUNTIME_IMAGE=${baseTag}`,
      "--label",
      `io.antnest.lifecycle-test=${config.project}`,
      "-f",
      "scripts/lifecycle-closeout/update.Dockerfile",
      "-t",
      imageTag,
      ".",
    ],
    true,
  );
  config.image = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    imageTag,
  ]);
  assert.match(config.image, /^sha256:[a-f0-9]{64}$/);
  config.imageTag = imageTag;
  config.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF = config.image;
  await docker(
    interruptionCompose(config.project, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--no-build",
    ]),
    true,
  );
  result = await runInterruptedUpdate(config, docker, abort.signal);
} finally {
  clearTimeout(timer);
  const errors = [];
  try {
    if (config) await cleanup(config);
  } catch (error) {
    errors.push(error);
  }
  try {
    if (config)
      await removeTestImages(dockerClient(config.env, undefined, 60000), [
        imageTag,
        baseTag,
      ]);
  } catch (error) {
    errors.push(error);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (errors.length)
    throw new AggregateError(errors, "Interrupted-update cleanup failed");
}
console.log(
  JSON.stringify({ status: "passed", ...result, cleanup: "verified" }),
);
