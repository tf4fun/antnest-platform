import assert from "node:assert/strict";
import { composeArgs, dockerClient } from "../lifecycle-closeout/docker.mjs";

export const learningImageOverlay = [
  "-f",
  "tests/e2e/skill-learning/images.compose.yaml",
];

const settings = [
  "ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS",
  "ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID",
];

export async function assertStandardComposeIgnoresDebugSettings(
  config,
  signal,
) {
  // Simulate an operator shell left over from a debug run. Ordinary deployment
  // must ignore both settings even when the operator exported valid values.
  const docker = dockerClient(
    {
      ...config.env,
      ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: "true",
      ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "agent-host-debug",
    },
    signal,
    240_000,
  );
  const overlay = [
    "-f",
    "tests/e2e/workspace-closeout/c4.compose.yaml",
    ...learningImageOverlay,
  ];
  const rendered = JSON.parse(
    await docker(
      composeArgs(config.project, [...overlay, "config", "--format", "json"]),
    ),
  );
  for (const variable of settings)
    assert(
      !Object.hasOwn(
        rendered.services["agent-acp-service"].environment,
        variable,
      ),
    );
  await docker(
    composeArgs(config.project, [
      ...overlay,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--no-build",
    ]),
    true,
  );
  const container = await docker(
    composeArgs(config.project, [...overlay, "ps", "-q", "agent-acp-service"]),
  );
  const [actual] = JSON.parse(await docker(["inspect", container]));
  assert.equal(actual.State.Health.Status, "healthy");
  for (const variable of settings)
    assert(
      !actual.Config.Env.some((entry) => entry.startsWith(`${variable}=`)),
    );
  await assertLearningDebugWarning({ docker, container });
  return { standard_stack_healthy: true, host_debug_settings_absent: true };
}

export async function assertLearningDebugWarning({
  docker,
  container,
  agentId,
}) {
  const warnings = (await docker(["logs", container]))
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "Skill learning debug mode is active");
  assert.equal(warnings.length, agentId === undefined ? 0 : 1);
  if (agentId !== undefined) {
    assert.equal(warnings[0].level, "warn");
    assert.equal(warnings[0].agent_id, agentId);
  }
}
