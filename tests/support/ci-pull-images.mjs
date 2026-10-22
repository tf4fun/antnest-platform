import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { auxiliaryCollectorImage } from "./ci-changes.mjs";
import { createTraceDiagnostics } from "./trace-diagnostics.mjs";
import { writeEvidenceFile } from "./storage.mjs";
import { inspect } from "node:util";

function inventory(images) {
  assert(Array.isArray(images), "image inventory must be an array");
  assert(
    images.every(
      (image) => typeof image === "string" && /^[^\s]+$/u.test(image),
    ),
    "image inventory must contain nonempty tokens",
  );
  assert.equal(
    new Set(images).size,
    images.length,
    "duplicate image ownership",
  );
}

export async function pullCiImages({
  required,
  auxiliary,
  directory,
  signal,
  pullImage,
  budgetMs = 60_000,
}) {
  inventory(required);
  inventory(auxiliary);
  assert(
    auxiliary.every((image) => image === auxiliaryCollectorImage),
    "only the pinned collector is auxiliary",
  );
  assert(
    auxiliary.every((image) => !required.includes(image)),
    "image ownership overlaps",
  );
  if (pullImage !== undefined) assert.equal(typeof pullImage, "function");
  const trace = createTraceDiagnostics({ directory, signal, budgetMs });
  signal?.throwIfAborted();
  if (!pullImage && required.length + auxiliary.length > 0) {
    // Reuse the owned Docker command adapter: abort kills its process group,
    // and its Promise settles only after the actual child close event.
    const { dockerClient } =
      await import("../e2e/lifecycle-closeout/docker.mjs");
    const docker = dockerClient(process.env, signal);
    pullImage = (image, callSignal) =>
      docker(["pull", image], true, { signal: callSignal });
  }
  for (const image of required) {
    signal?.throwIfAborted();
    await pullImage(image, signal);
    signal?.throwIfAborted();
  }
  for (const image of auxiliary) {
    await trace.run("collector-image-pull", (localSignal) =>
      pullImage(image, localSignal),
    );
  }
  signal?.throwIfAborted();
  return { required: required.length, trace: trace.summary() };
}

async function main() {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new Error("CI image pulling cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const directory = "artifacts/verification/ci-pull-images";
  const tokens = (value = "") => value.trim().split(/\s+/u).filter(Boolean);
  try {
    const result = await pullCiImages({
      required: tokens(process.env.IMAGES),
      auxiliary: tokens(process.env.AUXILIARY_IMAGES),
      directory,
      signal: controller.signal,
    });
    console.log(JSON.stringify(result));
    if (result.trace.status === "warning") {
      console.log(
        "::warning::Collector image pull reported a diagnostic warning; continuing independent business checks. See Trace diagnostics artifact.",
      );
    }
  } catch (error) {
    try {
      writeEvidenceFile(
        directory,
        "required-pull-failure.private.txt",
        inspect(error, { depth: 8 }) + "\n",
      );
    } catch {
      console.error("Image pull failure evidence could not be saved.");
    }
    console.error(
      "Required image pulling failed or was cancelled; business checks have not run.",
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
