import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { dockerClient } from "../e2e/lifecycle-closeout/docker.mjs";
import { runCommand } from "./run-command.mjs";
import { durablePath } from "./storage.mjs";

export async function dockerTestEnvironment({
  image,
  movedImage,
  env = process.env,
  docker,
  signal,
}) {
  for (const reference of [image, movedImage])
    assert(
      typeof reference === "string" &&
        reference.length > 0 &&
        !/^[\s-]|[\s\0]/.test(reference),
      "explicit image reference required",
    );
  docker ??= dockerClient(env, signal, 60000);
  const host =
    env.DOCKER_HOST ||
    (await docker([
      "context",
      "inspect",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]));
  assert(
    host.startsWith("unix://") && isAbsolute(host.slice(7)),
    "Docker image tests require a Unix endpoint",
  );
  const rows = JSON.parse(
    await docker(["image", "inspect", image, movedImage]),
  );
  assert(
    Array.isArray(rows) &&
      rows.length === 2 &&
      rows.every((row) => typeof row.Id === "string" && row.Id.length > 0),
    "both test images must be installed",
  );
  assert.notEqual(
    rows[0].Id,
    rows[1].Id,
    "test image references must resolve to different images",
  );
  return {
    ...env,
    ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET: host.slice(7),
    ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG: image,
    ANTNEST_RUNTIME_CONTROLLER_TEST_MOVED_IMAGE_TAG: movedImage,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      image: { type: "string" },
      "moved-image": { type: "string" },
      output: { type: "string" },
      name: { type: "string" },
      "timeout-ms": { type: "string", default: "900000" },
      "grace-ms": { type: "string", default: "30000" },
    },
  });
  assert(
    values.output && values.name && positionals.length,
    "expected --image REF --moved-image REF --output DIR --name NAME -- COMMAND ARGS",
  );
  const output = durablePath(values.output);
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  try {
    const env = await dockerTestEnvironment({
      image: values.image,
      movedImage: values["moved-image"],
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    const result = await runCommand({
      command: positionals,
      output,
      name: values.name,
      env,
      timeoutMs: Number(values["timeout-ms"]),
      graceMs: Number(values["grace-ms"]),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exit_code;
  } catch {
    console.error(
      "Docker image test preflight or execution failed; no image was pulled or built by this adapter.",
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  }
}
