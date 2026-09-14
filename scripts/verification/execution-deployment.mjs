import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyExecutionDeployment(config) {
  const controller = config.services?.["agent-controller"];
  const acp = config.services?.["agent-acp-service"];
  assert(controller && acp, "both execution services must be configured");
  const producer = controller.environment ?? {};
  const consumer = acp.environment ?? {};
  const rawOrigin = producer.ANTNEST_AGENT_ACP_SERVICE_URL ?? "";
  const origin = URL.parse(rawOrigin);
  assert(
    origin &&
      /^https?:\/\/[^/?#\\\s]+\/?$/iu.test(rawOrigin) &&
      ["http:", "https:"].includes(origin.protocol) &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === "/",
    "Controller must have an ACP HTTP publication origin",
  );
  for (const key of [
    "ANTNEST_AGENT_CONTROLLER_URL",
    "ANTNEST_ACP_CONTROLLER_TIMEOUT",
  ]) {
    assert(!(key in consumer), `retired ACP environment key: ${key}`);
  }
  const consoleService = config.services?.["admin-console"];
  if (consoleService) {
    assert(
      consoleService.environment?.ANTNEST_AGENT_ACP_SERVICE_URL === rawOrigin,
      "Console audit consumer must target the configured ACP origin",
    );
  }
  assert(
    !("ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL" in producer),
    "Controller must not configure Run admission TTL",
  );
  const maxBytes = Number(producer.ANTNEST_ACP_MAX_CONFIGURATION_BYTES);
  assert(
    /^\d+$/u.test(producer.ANTNEST_ACP_MAX_CONFIGURATION_BYTES ?? "") &&
      /^\d+$/u.test(consumer.ANTNEST_ACP_MAX_CONFIGURATION_BYTES ?? "") &&
      Number.isInteger(maxBytes) &&
      maxBytes >= 1024 &&
      maxBytes <= 67108864 &&
      maxBytes === Number(consumer.ANTNEST_ACP_MAX_CONFIGURATION_BYTES),
    "both services must explicitly configure the same supported snapshot limit",
  );
  assert(
    typeof consumer.ANTNEST_ACP_RUN_TIMEOUT === "string" &&
      consumer.ANTNEST_ACP_RUN_TIMEOUT.trim(),
    "ACP must configure its local execution timeout",
  );
  assert(
    !controller.depends_on?.["agent-acp-service"] &&
      !acp.depends_on?.["agent-controller"],
    "execution services must start independently; application synchronization gates execution",
  );
  assert(
    Object.keys(controller.networks ?? {}).some(
      (network) => network in (acp.networks ?? {}),
    ),
    "Controller and ACP must share a network for configuration publication",
  );
  return {
    direction: "agent-controller -> agent-acp-service",
    maxConfigurationBytes: maxBytes,
    runTimeout: consumer.ANTNEST_ACP_RUN_TIMEOUT,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = verifyExecutionDeployment(
      JSON.parse(readFileSync(0, "utf8")),
    );
    process.stdout.write(
      `${JSON.stringify({ status: "passed", scope: "deployment-wiring", ...result })}\n`,
    );
  } catch {
    process.stderr.write(
      "Controller/ACP deployment preflight failed; check publication configuration, limits and startup dependencies.\n",
    );
    process.exitCode = 1;
  }
}
