import assert from "node:assert/strict";
import test from "node:test";
import {
  shellComposeFiles,
  shellFixtureEnvironment,
} from "./authenticated-shell-e2e.mjs";
import * as shell from "./authenticated-shell-e2e.mjs";

test("Shutdown gets fresh candidate images and retains its whole-platform maintenance profile", () => {
  assert.deepEqual(
    shellComposeFiles("lifecycle-shutdown"),
    shellComposeFiles("lifecycle-health"),
  );
  assert.deepEqual(shell.shellEntrypoint("lifecycle-shutdown"), [
    "node",
    "tests/e2e/lifecycle-closeout/run.mjs",
    "shutdown",
  ]);
});

test("Default Restore gets fresh images without selecting the later Skill profile", () => {
  assert.deepEqual(
    shellComposeFiles("lifecycle-restore"),
    shellComposeFiles("lifecycle-health"),
  );
  assert.deepEqual(shell.shellEntrypoint("lifecycle-restore"), [
    "node",
    "tests/e2e/lifecycle-closeout/run.mjs",
    "restore",
  ]);
});

test("Loss gets fresh candidate images and preserves its two Runtime-loss cases", () => {
  assert.deepEqual(
    shellComposeFiles("lifecycle-loss"),
    shellComposeFiles("lifecycle-health"),
  );
  assert.deepEqual(shell.shellEntrypoint("lifecycle-loss"), [
    "node",
    "tests/e2e/lifecycle-closeout/run.mjs",
    "loss",
  ]);
});

test("Network gets fresh candidate images and its original business profile", () => {
  assert.deepEqual(
    shellComposeFiles("lifecycle-network"),
    shellComposeFiles("lifecycle-health"),
  );
  assert.deepEqual(shell.shellEntrypoint("lifecycle-network"), [
    "node",
    "tests/e2e/lifecycle-closeout/run.mjs",
    "network",
  ]);
});

test("Health gets a fresh scoped candidate and its own business profile", () => {
  assert.deepEqual(shellComposeFiles("lifecycle-health"), [
    "compose.yaml",
    "compose.debug.yaml",
    "tests/integration/deployment/compose.admission.yaml",
  ]);
  assert.equal(typeof shell.shellEntrypoint, "function");
  assert.deepEqual(shell.shellEntrypoint("lifecycle-health"), [
    "node",
    "tests/e2e/lifecycle-closeout/run.mjs",
    "health",
  ]);
  assert.deepEqual(shell.shellEntrypoint("lifecycle"), [
    "node",
    "tests/e2e/lifecycle-closeout/run.mjs",
  ]);
});

test("stage1 uses the base deployment without publishing diagnostic ports", () => {
  assert.deepEqual(shellComposeFiles("stage1"), [
    "compose.yaml",
    "tests/integration/deployment/compose.admission.yaml",
  ]);
  assert(shellComposeFiles("stage2").includes("tests/e2e/stage2.compose.yaml"));
  assert(
    shellComposeFiles("runtime-controller").includes("compose.debug.yaml"),
  );
  assert.throws(() => shellComposeFiles("retained"));
});

test("shell fixtures discard operator secrets and bind all private addresses to their own scope", () => {
  const env = shellFixtureEnvironment({
    inherited: {
      PATH: "/node",
      ANTNEST_SERVICE_AUTH_DIRECTORY: "/operator",
      COMPOSE_FILE: "operator.yaml",
      OTEL_EXPORTER_OTLP_ENDPOINT: "operator",
    },
    project: "antnest-lifecycle-1234abcd",
    octet: 7,
    authentication: {
      ANTNEST_SERVICE_AUTH_DIRECTORY: "/fixture",
      ANTNEST_SERVICE_AUTH_UID: "501",
    },
    tag: "review-1234abcd",
    runtimeImage: "antnest/antnest-runtime:review-1234abcd",
  });
  assert.equal(env.PATH, "/node");
  assert.equal(env.ANTNEST_SERVICE_AUTH_DIRECTORY, "/fixture");
  assert.equal(env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS, "true");
  assert.equal(env.COMPOSE_ENV_FILES, ".env.example");
  assert.equal(env.COMPOSE_FILE, undefined);
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.equal(env.ANTNEST_ADMISSION_TAG, "review-1234abcd");
  assert.equal(
    env.ANTNEST_E2E_RUNTIME_IMAGE,
    "antnest/antnest-runtime:review-1234abcd",
  );
  assert.equal(env.ANTNEST_AGENT_CONTROLLER_CONTROL_IPV4, "10.242.7.4");
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_MANAGEMENT_IPV4, "10.243.7.5");
  assert.equal(env.ANTNEST_ACP_MANAGEMENT_IPV4, "10.243.7.6");
});

test("Skill-restore fresh candidate entrypoint keeps the business profile explicit", () => {
  assert.deepEqual(shell.shellEntrypoint("stage4-skill-restore"), [
    "node",
    "tests/e2e/lifecycle-closeout/run.mjs",
    "skill-restore",
  ]);
});
