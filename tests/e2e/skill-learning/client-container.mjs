import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { grantContainerArgs } from "../../support/service-grants.mjs";

// Plain clients retain their original networks and grants. Only private ACP
// consumers also reach Identity, ACP and the actual CLIENT trace exporter.
export function skillClientArgs(
  config,
  { grants = [], privateACP = false } = {},
) {
  assert.equal(typeof privateACP, "boolean");
  const wanted = [
    ...new Set([
      ...grants,
      ...(privateACP ? ["gateway-identity", "agent-ui-acp"] : []),
    ]),
  ];
  const granted = grantContainerArgs(config, wanted);
  const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(
    /\/$/u,
    "",
  );
  return [
    "--label",
    `com.docker.compose.project=${config.project}`,
    ...[
      "gateway-ingress",
      "acp-provider",
      ...granted.networks,
      ...(privateACP ? ["observability"] : []),
    ].flatMap((network) => ["--network", `${config.project}_${network}`]),
    ...granted.args,
    ...(privateACP
      ? [
          "contracts/agent-acp/agent-execution-state.ids-v2.schema.json",
          "contracts/common/ids.schema.json",
        ].flatMap((relative) => [
          "-v",
          `${root}/${relative}:/app/${relative}:ro`,
        ])
      : []),
  ];
}
