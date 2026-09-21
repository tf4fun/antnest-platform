import assert from "node:assert/strict";
import { createAccessCatalog } from "../identity-closeout/catalog.mjs";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
import { composeArgs } from "./docker.mjs";

export async function setupFoundation(admin, image) {
  const { model, template } = await createAccessCatalog(admin, {
    name: "Lifecycle fixture",
    baseURL: "http://stage3-model:8080/v1",
    modelName: "stage3-model",
    credential: "stage3-model-secret",
    systemPrompt: "Synthetic lifecycle test",
    maxModelRequests: 8,
    runtimeImage: image,
  });
  return {
    template,
    templateBody: {
      name: "Lifecycle fixture",
      model_profile_id: model.model_profile_id,
      system_prompt: "Synthetic lifecycle test",
      max_model_requests: 8,
      runtime: { image_ref: image },
    },
  };
}
export function configureFoundation(config) {
  config.controllerImage =
    config.env.ANTNEST_E2E_CONTROLLER_IMAGE ?? "antnest/agent-controller:local";
  config.runtimeControllerImage =
    config.env.ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE ??
    "antnest/runtime-controller:local";
  for (const [source, target] of [
    [
      "ANTNEST_EGRESS_CONTROL_SUBNET",
      "ANTNEST_LIFECYCLE_CONTROL_DYNAMIC_RANGE",
    ],
    [
      "ANTNEST_RUNTIME_MANAGEMENT_SUBNET",
      "ANTNEST_LIFECYCLE_RUNTIME_DYNAMIC_RANGE",
    ],
  ]) {
    assert.match(config.env[source], /^10\.24[23]\.\d+\.0\/24$/);
    config.env[target] = config.env[source].replace(".0/24", ".128/25");
  }
  config.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT = "false";
  config.compose = (args) =>
    composeArgs(config.project, [
      "-f",
      "scripts/lifecycle-closeout/foundation.compose.yaml",
      ...args,
    ]);
}
export function inspectFoundationDeployment(rows, config) {
  const service = (r) => r.Config.Labels["com.docker.compose.service"];
  const result = inspectDeployment(
    rows.filter((r) => service(r) !== "stage3-model"),
    config.project,
  );
  const peers = rows.filter((r) => service(r) === "stage3-model");
  assert.equal(peers.length, 1);
  const model = peers[0];
  assert.equal(
    model.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(model.State.Running, true);
  assert.equal(model.State.Health.Status, "healthy");
  const bindings = Object.values(model.HostConfig.PortBindings ?? {}).flat();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
  return { ...result, services: rows.length };
}
