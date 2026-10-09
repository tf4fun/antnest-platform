import { grantContainerArgs } from "../../support/service-grants.mjs";

// docker run arguments for a test client container. Every client reaches
// edge-gateway on gateway-ingress and the model fixture on acp-provider;
// grants add the receiver's private network and its disposable credential.
export function skillClientArgs(config, { grants = [] } = {}) {
  const granted = grantContainerArgs(config, grants);
  return [
    "--label",
    `com.docker.compose.project=${config.project}`,
    ...["gateway-ingress", "acp-provider", ...granted.networks].flatMap(
      (network) => ["--network", `${config.project}_${network}`],
    ),
    ...granted.args,
  ];
}
