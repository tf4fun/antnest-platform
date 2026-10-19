import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const moduleURL = new URL("./c4-configuration.mjs", import.meta.url);
const { c4Configuration } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});

function fixture(environment) {
  const calls = [],
    signal = new AbortController().signal,
    allocated = () => {};
  const config = {
    project: "antnest-lifecycle-01234567",
    image: "sha256:original-resolved-runtime",
    env: {
      ANTNEST_EGRESS_CONTROL_SUBNET: "10.242.7.0/24",
      ANTNEST_RUNTIME_MANAGEMENT_SUBNET: "10.243.7.0/24",
    },
  };
  const configuration = async (...args) => {
    calls.push(args);
    return config;
  };
  return {
    config,
    calls,
    signal,
    allocated,
    run: () => {
      assert.equal(typeof c4Configuration, "function");
      return c4Configuration(signal, allocated, { environment, configuration });
    },
  };
}

test("C4 preserves the fresh Runtime candidate through configuration and puts admission after its own image overrides", async () => {
  const tag = "shell-01234567",
    runtime = `antnest/antnest-runtime:${tag}`,
    f = fixture({
      ANTNEST_E2E_CANDIDATE_TAG: tag,
      ANTNEST_ADMISSION_TAG: tag,
      ANTNEST_E2E_RUNTIME_IMAGE: runtime,
    });
  const result = await f.run();
  assert.equal(result, f.config);
  assert.deepEqual(f.calls, [[f.signal, f.allocated, runtime]]);
  assert.equal(result.image, "sha256:original-resolved-runtime");
  assert.equal(result.env.ANTNEST_ADMISSION_TAG, tag);
  assert.equal(result.agentUIImage, `antnest/agent-ui:${tag}`);
  const args = result.compose(["up", "--no-build"]);
  const files = args.flatMap((arg, index) =>
    arg === "-f" ? [args[index + 1]] : [],
  );
  assert.deepEqual(files.slice(-3), [
    "tests/e2e/lifecycle-closeout/compose.yaml",
    "tests/e2e/workspace-closeout/c4.compose.yaml",
    "tests/integration/deployment/compose.admission.yaml",
  ]);
  assert.deepEqual(args.slice(-2), ["up", "--no-build"]);
  assert.equal(result.env.ANTNEST_C4_CONTROL_DYNAMIC_RANGE, "10.242.7.128/25");
  assert.equal(result.env.ANTNEST_C4_RUNTIME_DYNAMIC_RANGE, "10.243.7.128/25");
  assert.equal(result.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT, "false");
});

test("direct C4 configuration retains the explicit local development fallback", async () => {
  const f = fixture({}),
    result = await f.run();
  assert.deepEqual(f.calls, [
    [f.signal, f.allocated, "antnest/antnest-runtime:local"],
  ]);
  assert.equal(result.agentUIImage, "antnest/agent-ui:local");
  assert.equal(result.env.ANTNEST_ADMISSION_TAG, undefined);
  assert(
    !result
      .compose(["config"])
      .includes("tests/integration/deployment/compose.admission.yaml"),
  );
});

for (const [name, environment] of Object.entries({
  "invalid tag": {
    ANTNEST_E2E_CANDIDATE_TAG: "operator-tag",
    ANTNEST_E2E_RUNTIME_IMAGE: "antnest/antnest-runtime:operator-tag",
  },
  "missing Runtime candidate": { ANTNEST_E2E_CANDIDATE_TAG: "shell-01234567" },
  "missing application candidate": {
    ANTNEST_E2E_RUNTIME_IMAGE: "antnest/antnest-runtime:shell-01234567",
  },
  "different Runtime candidate": {
    ANTNEST_E2E_CANDIDATE_TAG: "shell-01234567",
    ANTNEST_E2E_RUNTIME_IMAGE: "antnest/antnest-runtime:local",
  },
  "different admission tag": {
    ANTNEST_E2E_CANDIDATE_TAG: "shell-01234567",
    ANTNEST_E2E_RUNTIME_IMAGE: "antnest/antnest-runtime:shell-01234567",
    ANTNEST_ADMISSION_TAG: "shell-76543210",
  },
}))
  test(`C4 rejects ${name} before allocation or credential preparation`, async () => {
    const f = fixture(environment);
    assert.equal(typeof c4Configuration, "function");
    await assert.rejects(f.run);
    assert.deepEqual(f.calls, []);
  });

test("the public C4 make target runs the fresh-candidate wrapper", async () => {
  const makefile = await readFile(
    new URL("../../../Makefile", import.meta.url),
    "utf8",
  );
  assert.match(
    makefile,
    /^e2e-workspace-browser:\n\tnode tests\/support\/authenticated-shell-e2e\.mjs workspace-browser$/mu,
  );
});
