import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  candidateCommand,
  candidateContext,
  candidateEnvironment,
  providedImages,
  providedVariable,
} from "./candidate-images.mjs";

const helper = fileURLToPath(
  new URL("./candidate-images.mjs", import.meta.url),
);
const tag = "antnest/antnest-runtime:shell-1";
const build = [
  "docker",
  "build",
  "-f",
  "runtimes/antnest-runtime/Dockerfile",
  "-t",
  tag,
  ".",
];

test("provided images are the comma-separated CI image names", () => {
  assert.deepEqual([...providedImages({})], []);
  assert.deepEqual(
    [
      ...providedImages({
        [providedVariable]: " antnest-runtime, runtime-egress,,",
      }),
    ],
    ["antnest-runtime", "runtime-egress"],
  );
  assert.throws(
    () => providedImages({ [providedVariable]: "antnest-runtime,unknown" }),
    /unknown provided image unknown/u,
  );
});

test("a provided image becomes the candidate through a label-only build", () => {
  const env = { [providedVariable]: "antnest-runtime" };
  assert.deepEqual(
    candidateCommand(
      {
        name: "antnest-runtime",
        tag,
        build,
        labels: { "io.antnest.test-project": "p-1" },
      },
      env,
    ),
    [
      "docker",
      "build",
      "--label",
      "io.antnest.test-project=p-1",
      "--build-arg",
      "IMAGE=antnest/antnest-runtime:local",
      "-f",
      `${candidateContext}/Dockerfile`,
      "-t",
      tag,
      candidateContext,
    ],
  );
  const dockerfile = readFileSync(`${candidateContext}/Dockerfile`, "utf8");
  assert.deepEqual(
    dockerfile.split("\n").filter((line) => line && !line.startsWith("#")),
    ["ARG IMAGE", "FROM ${IMAGE}"],
  );
});

test("an image CI did not provide is built from source", () => {
  assert.equal(
    candidateCommand({ name: "antnest-runtime", tag, build }, {}),
    build,
  );
  assert.equal(
    candidateCommand(
      { name: "antnest-runtime", tag, build },
      { [providedVariable]: "runtime-egress" },
    ),
    build,
  );
});

test("candidate builds run without the stack's trace exporter settings", () => {
  // Buildx exports its own build traces to OTEL_EXPORTER_OTLP_ENDPOINT, and
  // the stack's collector address does not resolve on the host.
  const env = {
    PATH: "/usr/bin",
    ANTNEST_ADMISSION_TAG: "shell-1",
    COMPOSE_FILE: "compose.yaml",
    [providedVariable]: "antnest-runtime",
    OTEL_SDK_DISABLED: "false",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318",
    OTEL_TRACES_EXPORTER: "otlp",
  };
  const copy = { ...env };
  assert.deepEqual(candidateEnvironment(env), {
    PATH: "/usr/bin",
    ANTNEST_ADMISSION_TAG: "shell-1",
    COMPOSE_FILE: "compose.yaml",
    [providedVariable]: "antnest-runtime",
  });
  assert.deepEqual(env, copy);
});

test("candidate names, tags, labels and builds are validated first", () => {
  assert.throws(
    () =>
      candidateCommand(
        { name: "unknown", tag: "antnest/unknown:x", build },
        {},
      ),
    /unknown image unknown/u,
  );
  for (const bad of ["", "-t", "antnest/antnest-runtime:local", "a b"])
    assert.throws(
      () => candidateCommand({ name: "antnest-runtime", tag: bad, build }, {}),
      /candidate tag/u,
      bad,
    );
  assert.throws(
    () => candidateCommand({ name: "antnest-runtime", tag, build: [] }, {}),
    /build command/u,
  );
  for (const labels of [{ "": "x" }, { "a=b": "x" }, { a: "x\ny" }])
    assert.throws(
      () =>
        candidateCommand({ name: "antnest-runtime", tag, build, labels }, {}),
      /label/u,
    );
});

test("the command line passes labels and otherwise runs the build", () => {
  const run = (args) =>
    spawnSync(process.execPath, [helper, ...args], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
  const built = run([
    "antnest-runtime",
    tag,
    "--label",
    "io.antnest.test-project=p-1",
    "--",
    process.execPath,
    "-e",
    "console.log('built')",
  ]);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.stdout.trim(), "built");
  const failed = run([
    "antnest-runtime",
    tag,
    "--",
    process.execPath,
    "-e",
    "process.exit(3)",
  ]);
  assert.equal(failed.status, 3);
  const traced = spawnSync(
    process.execPath,
    [
      helper,
      "antnest-runtime",
      tag,
      "--",
      process.execPath,
      "-e",
      "console.log(Object.keys(process.env).filter((k) => k.startsWith('OTEL_')).length)",
    ],
    {
      env: { PATH: process.env.PATH, OTEL_TRACES_EXPORTER: "otlp" },
      encoding: "utf8",
    },
  );
  assert.equal(traced.status, 0, traced.stderr);
  assert.equal(traced.stdout.trim(), "0");
  for (const args of [
    ["antnest-runtime"],
    ["antnest-runtime", tag, "--label", "x"],
  ]) {
    const usage = run(args);
    assert.notEqual(usage.status, 0);
    assert.match(
      usage.stderr,
      /NAME TAG \[--label KEY=VALUE\]\.\.\. -- BUILD/u,
    );
  }
});
