// CI shards load antnest/<name>:local for each image their suites declare,
// built from this checkout's build inputs (tests/support/ci-changes.mjs).
// A runner that needs an isolated candidate tag derives it from that image
// instead of rebuilding without a layer cache; elsewhere it builds from
// source, so a stale local image is never mistaken for the checkout. The
// derived image carries the labels the replaced build would have set, because
// cleanup checks ownership through them.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { images } from "./ci-changes.mjs";

export const providedVariable = "ANTNEST_CI_PROVIDED_IMAGES";
export const candidateContext = fileURLToPath(
  new URL("./candidate-image", import.meta.url),
);
const usage =
  "usage: candidate-images.mjs NAME TAG [--label KEY=VALUE]... -- BUILD COMMAND...";

function known(name, what) {
  if (!Object.hasOwn(images, name)) throw new Error(`unknown ${what} ${name}`);
  return name;
}

export function providedImages(env = process.env) {
  return new Set(
    (env[providedVariable] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => known(name, "provided image")),
  );
}

export function candidateCommand(
  { name, tag, build, labels = {} },
  env = process.env,
) {
  known(name, "image");
  if (
    typeof tag !== "string" ||
    !/^[a-z0-9][\w./-]*:\w[\w.-]*$/u.test(tag) ||
    tag === `antnest/${name}:local`
  )
    throw new Error(`invalid candidate tag ${JSON.stringify(tag)}`);
  if (!Array.isArray(build) || build.length === 0)
    throw new Error("a build command is required");
  const pairs = Object.entries(labels);
  for (const [key, value] of pairs)
    if (!/^[\w.-]+$/u.test(key) || /[\0\r\n]/u.test(String(value)))
      throw new Error(`invalid label ${JSON.stringify(key)}`);
  if (!providedImages(env).has(name)) return build;
  return [
    "docker",
    "build",
    ...pairs.flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--build-arg",
    `IMAGE=antnest/${name}:local`,
    "-f",
    `${candidateContext}/Dockerfile`,
    "-t",
    tag,
    candidateContext,
  ];
}

// Buildx exports its own build traces when OTEL_* names an exporter, and a
// stack's collector address (http://jaeger:4318) only resolves inside the
// stack, so every build would wait for the export to time out. Builds do not
// read these settings: the compose files give each one a default.
export function candidateEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("OTEL_")),
  );
}

function parseCommandLine(args) {
  const [name, tag, ...rest] = args;
  const labels = {};
  while (rest[0] === "--label") {
    const pair = rest[1] ?? "";
    const split = pair.indexOf("=");
    if (split <= 0) return undefined;
    labels[pair.slice(0, split)] = pair.slice(split + 1);
    rest.splice(0, 2);
  }
  if (!name || !tag || rest[0] !== "--" || rest.length < 2) return undefined;
  return { name, tag, labels, build: rest.slice(1) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseCommandLine(process.argv.slice(2));
  if (!parsed) {
    console.error(usage);
    process.exit(64);
  }
  const [command, ...args] = candidateCommand(parsed);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: candidateEnvironment(),
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
