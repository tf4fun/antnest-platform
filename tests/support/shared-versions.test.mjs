import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moduleURL = new URL(
  "../../scripts/check-shared-versions.mjs",
  import.meta.url,
);
const implementation = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    (error.url !== moduleURL.href &&
      !error.message.includes(moduleURL.pathname))
  )
    throw error;
  return {};
});

const SDK = "@agentclientprotocol/sdk";
const PINNED = "1.5.0";
const DRIFTED = "0.9.0";
const REQUIRED_PACKAGES = [
  "services/agent-acp-service",
  "services/agent-ui/web",
];

function checkSharedVersions(root) {
  assert.equal(
    typeof implementation.checkSharedVersions,
    "function",
    "checkSharedVersions is exported",
  );
  return implementation.checkSharedVersions(root);
}

async function problems(root) {
  const found = await checkSharedVersions(root);
  assert.ok(Array.isArray(found), "checkSharedVersions returns an array");
  for (const problem of found)
    assert.equal(typeof problem, "string", "problems are strings");
  return found;
}

function expectMismatch(found, relative, actual) {
  assert.notEqual(found.length, 0, "expected shared-version problems");
  assert(
    found.some(
      (problem) =>
        problem.includes(relative) &&
        problem.includes(PINNED) &&
        problem.includes(actual),
    ),
    `expected a problem naming ${relative} with ${PINNED} vs ${actual}: ${JSON.stringify(found)}`,
  );
}

function expectMissing(found, relative) {
  assert.notEqual(found.length, 0, "expected shared-version problems");
  assert(
    found.some(
      (problem) => problem.includes(relative) && problem.includes(PINNED),
    ),
    `expected a problem naming ${relative} and ${PINNED}: ${JSON.stringify(found)}`,
  );
}

function expectFileProblem(found, relative) {
  assert.notEqual(found.length, 0, "expected shared-version problems");
  assert(
    found.some((problem) => problem.includes(relative)),
    `expected a problem naming ${relative}: ${JSON.stringify(found)}`,
  );
}

function writeJSON(root, relative, value) {
  const file = join(root, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function manifest(version) {
  return { name: "fixture-consumer", dependencies: { [SDK]: version } };
}

function lockfile(declared, resolved = declared, packages = {}) {
  return {
    name: "fixture-consumer",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { [SDK]: declared } },
      [`node_modules/${SDK}`]: { version: resolved },
      ...packages,
    },
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "antnest-shared-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJSON(root, "tests/support/shared-versions.json", { [SDK]: PINNED });
  for (const dir of REQUIRED_PACKAGES) {
    writeJSON(root, `${dir}/package.json`, manifest(PINNED));
    writeJSON(root, `${dir}/package-lock.json`, lockfile(PINNED));
  }
  return root;
}

test("aligned manifests and locks report no problems", async (t) => {
  const root = fixture(t);
  writeJSON(root, "services/agent-acp-cli/package.json", manifest(PINNED));
  writeJSON(root, "services/agent-acp-cli/package-lock.json", lockfile(PINNED));
  writeJSON(root, "tests/integration/agent-acp-service/package.json", {
    name: "integration-fixture",
    dependencies: { "other-sdk": "2.0.0" },
  });
  assert.deepEqual(await problems(root), []);
});

test("a drifted package declaration is reported", async (t) => {
  const root = fixture(t);
  writeJSON(root, "services/agent-acp-service/package.json", manifest(DRIFTED));
  expectMismatch(
    await problems(root),
    "services/agent-acp-service/package.json",
    DRIFTED,
  );
});

test("a drifted lock root dependency is reported", async (t) => {
  const root = fixture(t);
  writeJSON(
    root,
    "services/agent-ui/web/package-lock.json",
    lockfile(DRIFTED, PINNED),
  );
  expectMismatch(
    await problems(root),
    "services/agent-ui/web/package-lock.json",
    DRIFTED,
  );
});

test("a drifted resolved lock entry is reported", async (t) => {
  const root = fixture(t);
  writeJSON(
    root,
    "services/agent-acp-service/package-lock.json",
    lockfile(PINNED, DRIFTED),
  );
  expectMismatch(
    await problems(root),
    "services/agent-acp-service/package-lock.json",
    DRIFTED,
  );
});

test("a drifted nested SDK lock entry is reported", async (t) => {
  const root = fixture(t);
  writeJSON(root, "services/agent-ui/web/package-lock.json", {
    name: "fixture-consumer",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { [SDK]: PINNED } },
      [`node_modules/${SDK}`]: { version: PINNED },
      [`node_modules/left-pad/node_modules/${SDK}`]: { version: DRIFTED },
    },
  });
  expectMismatch(
    await problems(root),
    "services/agent-ui/web/package-lock.json",
    DRIFTED,
  );
});

test("missing required manifests and locks are reported", async (t) => {
  for (const relative of [
    "services/agent-acp-service/package.json",
    "services/agent-ui/web/package-lock.json",
  ]) {
    const root = fixture(t);
    rmSync(join(root, relative));
    expectFileProblem(await problems(root), relative);
  }
});

test("a non-exact manifest pin is reported", async (t) => {
  const root = fixture(t);
  writeJSON(
    root,
    "services/agent-acp-service/package.json",
    manifest(`^${PINNED}`),
  );
  expectMismatch(
    await problems(root),
    "services/agent-acp-service/package.json",
    `^${PINNED}`,
  );
});

test("conflicting declarations across manifest dependency fields are reported", async (t) => {
  for (const [dependencies, devDependencies] of [
    [DRIFTED, PINNED],
    [PINNED, DRIFTED],
  ]) {
    const root = fixture(t);
    writeJSON(root, "services/agent-acp-service/package.json", {
      name: "agent-acp-service",
      dependencies: { [SDK]: dependencies },
      devDependencies: { [SDK]: devDependencies },
    });
    expectMismatch(
      await problems(root),
      "services/agent-acp-service/package.json",
      DRIFTED,
    );
  }
});

test("conflicting declarations across lock root dependency fields are reported", async (t) => {
  for (const [dependencies, devDependencies] of [
    [DRIFTED, PINNED],
    [PINNED, DRIFTED],
  ]) {
    const root = fixture(t);
    const lock = lockfile(PINNED);
    lock.packages[""].dependencies = { [SDK]: dependencies };
    lock.packages[""].devDependencies = { [SDK]: devDependencies };
    writeJSON(root, "services/agent-ui/web/package-lock.json", lock);
    expectMismatch(
      await problems(root),
      "services/agent-ui/web/package-lock.json",
      DRIFTED,
    );
  }
});

test("a discovered package with a mismatched SDK declaration and lock is reported", async (t) => {
  const root = fixture(t);
  writeJSON(root, "tools/legacy-agent/package.json", manifest(DRIFTED));
  writeJSON(root, "tools/legacy-agent/package-lock.json", lockfile(DRIFTED));
  const found = await problems(root);
  expectMismatch(found, "tools/legacy-agent/package.json", DRIFTED);
  expectMismatch(found, "tools/legacy-agent/package-lock.json", DRIFTED);
});

test("missing SDK entries in required manifests and lock roots are reported", async (t) => {
  {
    const root = fixture(t);
    writeJSON(root, "services/agent-acp-service/package.json", {
      name: "agent-acp-service",
      dependencies: { "other-sdk": "2.0.0" },
    });
    expectMissing(
      await problems(root),
      "services/agent-acp-service/package.json",
    );
  }
  {
    const root = fixture(t);
    const lock = lockfile(PINNED);
    lock.packages[""].dependencies = {};
    writeJSON(root, "services/agent-ui/web/package-lock.json", lock);
    expectMissing(
      await problems(root),
      "services/agent-ui/web/package-lock.json",
    );
  }
  {
    const root = fixture(t);
    const lock = lockfile(PINNED);
    delete lock.packages[`node_modules/${SDK}`];
    writeJSON(root, "services/agent-acp-service/package-lock.json", lock);
    expectMissing(
      await problems(root),
      "services/agent-acp-service/package-lock.json",
    );
  }
});

test("malformed JSON is reported as a problem instead of throwing", async (t) => {
  for (const relative of [
    "services/agent-ui/web/package.json",
    "services/agent-acp-service/package-lock.json",
    "tests/support/shared-versions.json",
  ]) {
    const root = fixture(t);
    writeFileSync(join(root, relative), "{ malformed\n");
    expectFileProblem(await problems(root), relative);
  }
});

test("a missing shared-version manifest is reported", async (t) => {
  const root = fixture(t);
  rmSync(join(root, "tests/support/shared-versions.json"));
  expectFileProblem(await problems(root), "tests/support/shared-versions.json");
});

test("a shared manifest without the SDK pin is rejected", async (t) => {
  for (const pins of [{ "other-sdk": "2.0.0" }, {}]) {
    const root = fixture(t);
    writeJSON(root, "tests/support/shared-versions.json", pins);
    expectFileProblem(
      await problems(root),
      "tests/support/shared-versions.json",
    );
  }
});

test("generated and vendored trees are ignored", async (t) => {
  const root = fixture(t);
  for (const relative of [
    "services/agent-acp-service/node_modules/example-dep/package.json",
    "services/agent-acp-service/node_modules/example-dep/package-lock.json",
    ".git/hooks/demo/package.json",
    ".cache/build/package.json",
    "artifacts/verification/run/package.json",
    "services/agent-ui/web/dist/package.json",
    "services/agent-ui/web/coverage/package.json",
    "tools/scratch/target/package.json",
  ])
    writeJSON(
      root,
      relative,
      relative.endsWith("lock.json") ? lockfile(DRIFTED) : manifest(DRIFTED),
    );
  assert.deepEqual(await problems(root), []);
});
