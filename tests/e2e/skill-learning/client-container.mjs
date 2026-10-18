import assert from "node:assert/strict";
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
  ];
}
