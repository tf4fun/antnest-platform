import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { selectSuites, suiteImages } from "./ci-changes.mjs";
import { cli, freezeManifest, validateManifest } from "./ci-manifest.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const revision = "a".repeat(40);
const digest = "b".repeat(64);
const mainImages = () =>
  suiteImages(selectSuites([], { all: true, scope: "e2e" }), {
    allImages: true,
  });
const frozen = (name) => ({
  ref: `ghcr.io/tf4fun/${
    name.startsWith("antnest-") ? name : `antnest-${name}`
  }@sha256:${digest}`,
  build: false,
});
const mainManifest = () => ({
  version: 1,
  revision,
  origin: "main",
  images: Object.fromEntries(mainImages().map((name) => [name, frozen(name)])),
});

test("a complete main version manifest validates", () => {
  assert.doesNotThrow(() =>
    validateManifest(mainManifest(), { required: mainImages() }),
  );
});

test("manifest shape is exact: version, revision hex, origin and known images", () => {
  for (const change of [
    (m) => {
      m.version = 2;
    },
    (m) => {
      m.revision = "abc";
    },
    (m) => {
      m.revision = revision.toUpperCase();
    },
    (m) => {
      m.origin = "branch";
    },
    (m) => {
      m.images.ghost = frozen("agent-ui");
    },
    (m) => {
      delete m.images["agent-ui"];
    },
    (m) => {
      m.images["agent-ui"].ref = "ghcr.io/tf4fun/antnest-agent-ui:inputs-abc";
    },
    (m) => {
      m.images["agent-ui"].ref =
        "ghcr.io/other/antnest-agent-ui@sha256:" + digest;
    },
    (m) => {
      m.images["agent-ui"].ref =
        `ghcr.io/tf4fun/antnest-agent-ui@sha256:${digest.slice(0, 40)}`;
    },
    (m) => {
      m.images["agent-ui"].build = "false";
    },
  ]) {
    const manifest = mainManifest();
    change(manifest);
    assert.throws(
      () => validateManifest(manifest, { required: mainImages() }),
      JSON.stringify(change.toString()),
    );
  }
});

test("required images must all be present", () => {
  const manifest = mainManifest();
  delete manifest.images["identity-service"];
  assert.throws(() => validateManifest(manifest, { required: mainImages() }));
  assert.doesNotThrow(() =>
    validateManifest(
      {
        ...manifest,
        images: { "identity-service": frozen("identity-service") },
      },
      { required: ["identity-service"] },
    ),
  );
});

test("PR artifact entries are an explicit exception, never release manifests", () => {
  const artifact = {
    version: 1,
    revision,
    origin: "pr",
    images: {
      temporal: { ref: "antnest/temporal:local", build: true },
      "agent-ui": {
        ref: `ghcr.io/tf4fun/antnest-agent-ui:inputs-${"c".repeat(32)}`,
        build: true,
      },
    },
  };
  assert.doesNotThrow(() =>
    validateManifest(artifact, {
      allowArtifacts: true,
      required: ["temporal", "agent-ui"],
    }),
  );
  assert.throws(
    () => validateManifest(artifact, { required: [] }),
    "a PR artifact manifest is never release evidence",
  );
  const mainArtifact = mainManifest();
  mainArtifact.images.temporal = {
    ref: "antnest/temporal:local",
    build: true,
  };
  assert.throws(
    () =>
      validateManifest(mainArtifact, {
        allowArtifacts: true,
        required: mainImages(),
      }),
    "main manifests never carry artifact entries",
  );
  const prFrozen = {
    ...artifact,
    images: { temporal: frozen("temporal") },
  };
  assert.throws(
    () => validateManifest(prFrozen, { required: [] }),
    "origin pr alone does not authorize a release manifest",
  );
});

test("freeze resolves every main image to its immutable registry digest", () => {
  const input = {
    revision,
    origin: "main",
    images: {
      temporal: {
        ref: `ghcr.io/tf4fun/antnest-temporal:inputs-${"d".repeat(32)}`,
        build: true,
      },
      "agent-ui": {
        ref: `ghcr.io/tf4fun/antnest-agent-ui:inputs-${"d".repeat(32)}`,
        build: false,
      },
    },
  };
  const inspected = [];
  const manifest = freezeManifest(input, (ref) => {
    inspected.push(ref);
    return `sha256:${digest}`;
  });
  assert.equal(inspected.length, 2, "main entries always inspect");
  for (const [name, entry] of Object.entries(manifest.images)) {
    assert.equal(entry.build, false, name);
    assert.match(entry.ref, /@sha256:[0-9a-f]{64}$/u, name);
  }
  assert.equal(input.images.temporal.build, true, "input never mutates");
  assert.equal(manifest.origin, "main");
  assert.equal(manifest.version, 1);
});

test("freeze retains PR build artifacts without invoking Docker", () => {
  const input = {
    revision,
    origin: "pr",
    images: {
      temporal: { ref: "antnest/temporal:local", build: true },
      "agent-ui": {
        ref: `ghcr.io/tf4fun/antnest-agent-ui:inputs-${"d".repeat(32)}`,
        build: false,
      },
    },
  };
  const inspected = [];
  const manifest = freezeManifest(input, (ref) => {
    inspected.push(ref);
    return `sha256:${digest}`;
  });
  assert.deepEqual(inspected, [input.images["agent-ui"].ref]);
  assert.deepEqual(manifest.images.temporal, {
    ref: "antnest/temporal:local",
    build: true,
  });
  assert.match(manifest.images["agent-ui"].ref, /@sha256:[0-9a-f]{64}$/u);
});

test("the validate CLI writes the manifest file and its outputs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-ci-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "manifest.json");
  const github = join(directory, "output");
  const result = spawnSync(
    process.execPath,
    ["tests/support/ci-manifest.mjs", "validate", output],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        MANIFEST_JSON: JSON.stringify(mainManifest()),
        GITHUB_OUTPUT: github,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), mainManifest());
  const lines = readFileSync(github, "utf8");
  assert.match(lines, new RegExp(`^revision=${revision}$`, "mu"));
  assert.match(lines, /^images=\{.*"ref".*\}$/mu);
});

test("the freeze CLI inspects registry images and reports the frozen set", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-ci-freeze-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "manifest.json");
  const github = join(directory, "output");
  const resolved = {
    "agent-ui": {
      ref: `ghcr.io/tf4fun/antnest-agent-ui:inputs-${"d".repeat(32)}`,
      build: false,
    },
  };
  cli(
    ["freeze", output],
    {
      REVISION: revision,
      ORIGIN: "main",
      RESOLVED: JSON.stringify(resolved),
      GITHUB_OUTPUT: github,
    },
    {
      inspect: () => `sha256:${digest}`,
      requiredImages: () => ["agent-ui"],
    },
  );
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(manifest.images["agent-ui"].build, false);
  const lines = readFileSync(github, "utf8");
  assert.match(
    lines,
    /^images=\{"agent-ui":\{"ref":"ghcr\.io\/tf4fun\/antnest-agent-ui@sha256:[0-9a-f]{64}","build":false\}\}$/mu,
  );
});
