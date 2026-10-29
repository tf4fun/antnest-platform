// Version manifests pin one repository revision to an immutable image set:
// every release image as package@sha256:<digest>. Test images (dependencies
// and Runtime test variants) are never registry packages: every run that
// consumes a manifest builds them from its revision as antnest/<name>:local.
// Pull request builds are artifacts, never release manifests.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  imageSpec,
  isPublishable,
  packageName,
  selectSuites,
  suiteImages,
} from "./ci-changes.mjs";

const registry = "ghcr.io/tf4fun";
const packageOf = (name) => `${registry}/${packageName(name)}`;
const immutable = /^(?<ref>.+)@sha256:(?<digest>[0-9a-f]{64})$/u;
const inputs = /^(?<ref>.+):inputs-[0-9a-f]{32}$/u;

const e2eImageSet = () =>
  suiteImages(selectSuites([], { all: true, scope: "e2e" }), {
    allImages: true,
  });

const fail = (message) => {
  throw new Error(`manifest: ${message}`);
};

export function validateManifest(
  value,
  { allowArtifacts = false, required = [] } = {},
) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("expected an object");
  if (value.version !== 1) fail("version must be 1");
  if (!/^[0-9a-f]{40}$/u.test(value.revision ?? ""))
    fail("revision must be a 40 character lowercase hex");
  if (value.origin !== "main" && value.origin !== "pr")
    fail("origin must be main or pr");
  if (value.origin === "pr" && !allowArtifacts)
    fail("PR artifact manifests are never release evidence");
  if (
    typeof value.images !== "object" ||
    value.images === null ||
    Array.isArray(value.images)
  )
    fail("images must be an object");
  for (const [name, entry] of Object.entries(value.images)) {
    imageSpec(name);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      fail(`${name} must be an object`);
    if (typeof entry.ref !== "string" || typeof entry.build !== "boolean")
      fail(`${name} requires a string ref and a boolean build`);
    const local = `antnest/${name}:local`;
    if (!isPublishable(name)) {
      if (entry.ref !== local || entry.build !== true)
        fail(`test image ${name} must be built in the run as ${local}`);
      continue;
    }
    const pkg = packageOf(name);
    if (entry.build === false) {
      const pinned = immutable.exec(entry.ref);
      if (pinned?.groups.ref !== pkg)
        fail(`${name} must pin ${pkg}@sha256:<64 lowercase hex>`);
      continue;
    }
    if (!(allowArtifacts && value.origin === "pr"))
      fail(`${name} carries a build artifact outside the PR exception`);
    const selected = inputs.exec(entry.ref);
    if (entry.ref !== local && selected?.groups.ref !== pkg)
      fail(`${name} artifact must be antnest/${name}:local or its inputs ref`);
  }
  for (const name of required)
    if (!Object.hasOwn(value.images, name))
      fail(`missing required image ${name}`);
  return value;
}

// Every main release image and every already-published ref freezes to its
// registry digest; test images and PR build artifacts keep their local
// reference for artifact loading and are never inspected. The input is
// never mutated.
export function freezeManifest({ revision, origin, images }, inspect) {
  if (!/^[0-9a-f]{40}$/u.test(revision ?? ""))
    fail("freeze requires a 40 character lowercase hex revision");
  if (origin !== "main" && origin !== "pr")
    fail("freeze requires origin main or pr");
  if (typeof images !== "object" || images === null || Array.isArray(images))
    fail("freeze requires an images object");
  for (const entry of Object.values(images))
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.ref !== "string" ||
      typeof entry.build !== "boolean"
    )
      fail("freeze requires { ref, build } entries");
  const frozen = {};
  for (const [name, entry] of Object.entries(images ?? {})) {
    imageSpec(name);
    if (!isPublishable(name)) {
      frozen[name] = { ref: `antnest/${name}:local`, build: true };
      continue;
    }
    if (origin === "main" || entry.build === false) {
      const digest = /^sha256:([0-9a-f]{64})$/u.exec(
        String(inspect(entry.ref)).trim(),
      )?.[1];
      if (!digest) fail(`${name} inspection did not return a sha256 digest`);
      frozen[name] = {
        ref: `${packageOf(name)}@sha256:${digest}`,
        build: false,
      };
      continue;
    }
    frozen[name] = { ref: entry.ref, build: true };
  }
  return { version: 1, revision, origin, images: frozen };
}

const inspectImage = (ref) =>
  JSON.parse(
    execFileSync(
      "docker",
      [
        "buildx",
        "imagetools",
        "inspect",
        ref,
        "--format",
        "{{json .Manifest}}",
      ],
      { encoding: "utf8", timeout: 60_000 },
    ),
  ).digest;

export function cli(
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
) {
  const [command, outputFile] = argv;
  const requiredImages = deps.requiredImages ?? e2eImageSet;
  const append = (line) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  };
  if (command === "freeze") {
    const resolved = JSON.parse(env.RESOLVED ?? "{}");
    const inspect = deps.inspect ?? inspectImage;
    const manifest = freezeManifest(
      { revision: env.REVISION, origin: env.ORIGIN, images: resolved },
      inspect,
    );
    validateManifest(manifest, {
      allowArtifacts: env.ORIGIN === "pr",
      required:
        env.ORIGIN === "main" ? requiredImages() : Object.keys(resolved),
    });
    writeFileSync(outputFile, JSON.stringify(manifest, null, 2) + "\n");
    append(`images=${JSON.stringify(manifest.images)}`);
    return manifest;
  }
  if (command === "validate") {
    const manifest = validateManifest(JSON.parse(env.MANIFEST_JSON ?? ""), {
      required: requiredImages(),
    });
    if (outputFile)
      writeFileSync(outputFile, JSON.stringify(manifest, null, 2) + "\n");
    // A replay rebuilds the manifest's test images from its revision.
    const builds = Object.entries(manifest.images)
      .filter(([, entry]) => entry.build)
      .map(([name, { ref }]) => ({ name, ref, publish: false }));
    append(`revision=${manifest.revision}`);
    append(`images=${JSON.stringify(manifest.images)}`);
    append(`builds=${JSON.stringify({ include: builds })}`);
    append(`building=${builds.length}`);
    return manifest;
  }
  throw new Error("usage: ci-manifest.mjs freeze|validate <output-file>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    cli();
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
