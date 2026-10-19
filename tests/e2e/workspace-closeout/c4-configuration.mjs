import assert from "node:assert/strict";
import {
  configuration as defaultConfiguration,
  composeArgs,
} from "../lifecycle-closeout/docker.mjs";

export async function c4Configuration(
  signal,
  beforeEffects = () => {},
  { environment = process.env, configuration = defaultConfiguration } = {},
) {
  // The shared fixture deliberately drops inherited ANTNEST_* variables.
  // Capture and validate the shell's paired candidates before allocating it.
  const tag = environment.ANTNEST_E2E_CANDIDATE_TAG,
    runtime = environment.ANTNEST_E2E_RUNTIME_IMAGE;
  if (tag !== undefined || runtime !== undefined) {
    assert(typeof tag === "string", "C4 application candidate required");
    assert(/^shell-[a-f0-9]{8}$/u.test(tag), "invalid C4 candidate tag");
    assert(
      runtime === `antnest/antnest-runtime:${tag}`,
      "C4 Runtime must belong to the same candidate",
    );
    if (environment.ANTNEST_ADMISSION_TAG !== undefined)
      assert(
        environment.ANTNEST_ADMISSION_TAG === tag,
        "C4 admission must belong to the same candidate",
      );
  }
  const config = await configuration(
    signal,
    beforeEffects,
    runtime ?? "antnest/antnest-runtime:local",
  );
  config.env.ANTNEST_BOOTSTRAP_ORGANIZATION_NAME = "Stage 3";
  if (tag !== undefined) config.env.ANTNEST_ADMISSION_TAG = tag;
  config.agentUIImage = tag
    ? `antnest/agent-ui:${tag}`
    : (config.env.ANTNEST_C4_AGENT_UI_IMAGE ?? "antnest/agent-ui:local");
  for (const [source, target] of [
    ["ANTNEST_EGRESS_CONTROL_SUBNET", "ANTNEST_C4_CONTROL_DYNAMIC_RANGE"],
    ["ANTNEST_RUNTIME_MANAGEMENT_SUBNET", "ANTNEST_C4_RUNTIME_DYNAMIC_RANGE"],
  ]) {
    assert.match(config.env[source], /^10\.24[23]\.\d+\.0\/24$/u);
    config.env[target] = config.env[source].replace(".0/24", ".128/25");
  }
  config.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT = "false";
  config.compose = (args) =>
    composeArgs(config.project, [
      "-f",
      "tests/e2e/workspace-closeout/c4.compose.yaml",
      ...(tag
        ? ["-f", "tests/integration/deployment/compose.admission.yaml"]
        : []),
      ...args,
    ]);
  return config;
}
