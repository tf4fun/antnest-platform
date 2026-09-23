import { lifecycleTrace, temporaryAgent } from "./development-lifecycle.mjs";
import { runtimeCommandId } from "../../e2e/stage3-base/contracts.mjs";

export function runtimeLossTrace(
  kind,
  agentId = temporaryAgent,
  generation = 2,
) {
  const f = lifecycleTrace(kind, agentId);
  if (kind !== "rebuild") return f;
  f.expected.missingSourceGeneration = generation;
  const target = f.trace.spans.find(
    (s) => s.operationName === "runtime.platform.create",
  );
  const owner = target.references[0].spanID;
  const add = (id, parent, operationName, time, fields) =>
    f.trace.spans.push({
      traceID: f.trace.traceID,
      spanID: id,
      processID: "runtime-controller",
      operationName,
      startTime: target.startTime + time,
      duration: 1,
      references: [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: parent },
      ],
      tags: Object.entries(fields).map(([key, value]) => ({ key, value })),
    });
  add("loss-update", owner, "runtime.lifecycle.update_runtime", -3, {
    "antnest.agent.id": agentId,
    "antnest.result": "completed",
    "antnest.operation.id": runtimeCommandId(
      f.expected.requestId,
      "runtime_update",
    ),
  });
  add("loss-inspect", "loss-update", "runtime.platform.inspect", -2, {
    "antnest.agent.id": agentId,
    "antnest.outcome": "completed",
    "antnest.platform": "docker",
    "antnest.runtime.generation": generation,
    "antnest.runtime.health": "absent",
    "antnest.runtime.platform_phase": "absent",
    "antnest.runtime.execution_id": "",
  });
  add("loss-missing", "loss-inspect", "HTTP GET docker", -2, {
    "span.kind": "client",
    "peer.service": "docker",
    "http.request.method": "GET",
    "http.response.status_code": 404,
    "antnest.outcome": "absent",
  });
  target.references[0].spanID = "loss-update";
  target.tags.push({
    key: "antnest.runtime.generation",
    value: generation + 1,
  });
  return f;
}

export function runtimeLossSnapshots(
  scope,
  startedAt = "1970-01-01T00:00:00.001Z",
) {
  return {
    restart: {
      Id: "a".repeat(64),
      Name: "/fixture-runtime-controller-1",
      Config: {
        Env: [`ANTNEST_RUNTIME_CONTROLLER_SCOPE=${scope}`],
        Labels: {
          "com.docker.compose.project": "fixture",
          "com.docker.compose.service": "runtime-controller",
        },
      },
      State: { StartedAt: startedAt },
    },
    compose: {
      name: "fixture",
      services: {
        "runtime-controller": {
          environment: { ANTNEST_RUNTIME_CONTROLLER_SCOPE: scope },
        },
      },
    },
  };
}
