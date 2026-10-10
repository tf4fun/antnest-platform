import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the root MCP client loads the service's locked SDK before validating setup", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./client-entry.mjs", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, TEST_RUNTIME_IMAGE: "", TEST_ACP_VERSION: "1" },
    },
  );
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr.trim());
  assert.equal(failure.stage, "setup");
  assert.equal(failure.error, "AssertionError");
  assert.equal(failure.code, "ERR_ASSERTION");
});

for (const version of ["1", "2"])
  test(`the v${version} container client validates setup without host scripts`, () => {
    const scripts = new URL("../../../scripts/", import.meta.url).href;
    const preload = `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (result.url.startsWith(${JSON.stringify(scripts)}))
          throw new Error("container has no host scripts");
        return result;
      }});
    `;
    const result = launch(preload, { TEST_ACP_VERSION: version });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /container has no host scripts/);
    const failure = JSON.parse(result.stderr.trim());
    assert.equal(failure.stage, "setup");
    assert.equal(failure.code, "ERR_ASSERTION");
  });

test("the host client still loads its Docker peer checks", () => {
  const peer = new URL("../runtime-egress/live-peer.mjs", import.meta.url).href;
  const stub = `
    console.log("host-peer-loaded");
    export const assertLivePeer = () => {};
    export const restartWithNewPeer = () => {};
    export const proveHealthDuringEgressOutage = () => {};
  `;
  const preload = `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      return result.url === ${JSON.stringify(peer)}
        ? { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(stub))}, shortCircuit: true }
        : result;
    }});
  `;
  const result = launch(preload, {
    TEST_DOCKER_PROJECT: "antnest-lifecycle-0000abcd",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), "host-peer-loaded");
  assert.equal(JSON.parse(result.stderr.trim()).stage, "setup");
});

function launch(preload, overrides) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript," + encodeURIComponent(preload),
      fileURLToPath(new URL("./client-entry.mjs", import.meta.url)),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        TEST_RUNTIME_IMAGE: "",
        TEST_ACP_VERSION: "1",
        TEST_DOCKER_PROJECT: "",
        TEST_EVIDENCE_DIRECTORY: "",
        ...overrides,
      },
    },
  );
}
