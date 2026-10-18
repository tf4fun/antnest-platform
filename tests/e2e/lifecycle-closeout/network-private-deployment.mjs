import assert from "node:assert/strict";
import { inspectFoundationPrivateDeployment } from "./foundation-private-deployment.mjs";
import { inspectNetworkTarget } from "./network-current.mjs";

export function inspectNetworkPrivateDeployment(rows, config) {
  assert.equal(rows.length, 17);
  inspectNetworkTarget(rows, config);
  // Preserve the validated private projection when removing the target. Using
  // the raw rows again would reintroduce the exporter and its test-only ports.
  return inspectFoundationPrivateDeployment(rows, config).filter(
    (row) =>
      row.Config.Labels["com.docker.compose.service"] !== "network-target",
  );
}
