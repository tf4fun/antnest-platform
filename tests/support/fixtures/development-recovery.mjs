import { fixture } from "../../e2e/stage3-base/trace-fixtures.mjs";

export const recoveryAgent = "agent_" + "d".repeat(32);
export const recoveryScope = "antnest-recovery-fixture";
export const recoveryVolume = "antnest-recovery-workspace";
export const recoveryBefore = "1".repeat(64);
export const recoveryAfter = "2".repeat(64);

export function recoveryTrace() {
  const f = fixture("rebuild");
  return JSON.parse(JSON.stringify(f).replaceAll("agent-test", recoveryAgent));
}

export function recoveryAgentState(recovered = false) {
  return {
    agent_id: recoveryAgent,
    lifecycle_state: "created",
    activation_state: "enabled",
    desired_state: "enabled",
    runtime_state: recovered ? "available" : "unavailable",
    active_operation_request_id: null,
    failure_code: recovered ? null : "runtime_execution_changed",
    configuration: {
      template: { template_id: "template-fixture", revision: 1 },
      model: { provider_id: "provider-fixture", model_id: "model-fixture" },
    },
    executable_execution_revision: recovered ? "execution-fixture" : null,
    runtime: {
      runtime_revision: "runtime-fixture",
      ...(recovered ? { runtime_execution_id: "execution-fixture" } : {}),
    },
  };
}

export function recoveryInspection(recovered = false) {
  return {
    Id: recovered ? recoveryAfter : recoveryBefore,
    Name: "/antnest-runtime-" + recoveryAgent,
    Config: {
      Labels: {
        "io.antnest.agent-id": recoveryAgent,
        "io.antnest.managed": "runtime",
        "io.antnest.runtime-controller-scope": recoveryScope,
      },
    },
    State: { Running: true },
    Mounts: [
      {
        Type: "volume",
        Name: recoveryVolume,
        Destination: "/workspace",
        RW: true,
      },
    ],
  };
}
