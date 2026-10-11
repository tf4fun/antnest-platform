import assert from "node:assert/strict";
import identity from "../../../contracts/identity/identity-contract.json" with { type: "json" };
import controller from "../../../contracts/agent-controller/control-contract.json" with { type: "json" };
import runtime from "../../../services/runtime-controller/api/control-contract.json" with { type: "json" };
import { tag, traceTopology } from "./trace-tree.mjs";

// These are protocol registrations, not a heuristic that treats any JSON URL
// as RPC. Keep metadata-only/private routes excluded as in the owning routers.
const controllerMetadataOnly = new Set([
  "POST /internal/managed-mcp-secrets/resolve",
  "POST /internal/provider-connections",
  "POST /internal/provider-connections/{connection_id}/discover-models",
  "POST /internal/provider-discovery/draft",
  "POST /internal/provider-connections/{connection_id}/credentials",
  "POST /internal/agent-templates",
  "POST /internal/agent-templates/{template_id}/revisions",
  "GET /internal/agent-events/watch",
  "GET /internal/agents/{agent_id}/events/watch",
]);
const controllerPatterns = new Set(
  Object.values(controller.resources)
    .flatMap((resource) => Object.values(resource))
    .filter((binding) => binding?.method && binding?.path)
    .map((binding) => `${binding.method} ${binding.path}`)
    .filter((pattern) => !controllerMetadataOnly.has(pattern)),
);
// Registered by skill_learning_policy.go alongside the main route table.
controllerPatterns.add("GET /internal/agents/{agent_id}/skill-learning-policy");
controllerPatterns.add("PUT /internal/agents/{agent_id}/skill-learning-policy");
const runtimePatterns = new Set(
  runtime.routes
    .filter(
      (binding) =>
        ![
          "/status",
          "/internal/runtime-observations/watch",
          "/internal/runtimes/{agent_id}/connection",
        ].includes(binding.path),
    )
    .map((binding) => `${binding.method} ${binding.path}`),
);
const egressMethods = new Map([
  ["PUT /internal/agent-networks/{agent_id}", "ensure_agent_network"],
  ["GET /internal/agent-networks/{agent_id}", "agent_network"],
  [
    "PUT /internal/agent-network-attachments/{agent_id}",
    "set_runtime_attachment",
  ],
  ["POST /internal/agent-networks/{agent_id}/release", "release_agent_network"],
  [
    "PUT /internal/policies/{policy_id}/revisions/{revision}",
    "put_policy_revision",
  ],
  [
    "GET /internal/policies/{policy_id}/revisions/{revision}",
    "policy_revision",
  ],
  ["GET /internal/agent-policy-assignments/{agent_id}", "policy_assignment"],
  ["PUT /internal/agent-policy-assignments/{agent_id}", "assign_policy"],
]);

export function assertReceivingRPCContent(trace, span) {
  const tree = traceTopology(trace);
  const method = tag(span, "http.request.method"),
    route = tag(span, "http.route");
  const pattern = `${method} ${route}`,
    rpcMethod = tag(span, "rpc.method");
  const service = tree.service(span),
    rpcService = tag(span, "rpc.service");
  assert.equal(tag(span, "span.kind"), "server");
  const client = tree.parent(span);
  assert.equal(tag(client, "span.kind"), "client");
  assert.equal(tag(client, "http.request.method"), method);
  if (service !== "antnest-runtime-egress")
    assert.equal(tag(span, "rpc.system.name"), "antnest.http-json");
  switch (service) {
    case "identity-service": {
      assert.equal(rpcService, "identity");
      const binding = identity.methods[rpcMethod];
      assert(binding);
      assert.equal(method, binding.method);
      assert.equal(route, identity.base_path + binding.path);
      break;
    }
    case "agent-controller":
      assert.equal(rpcService, service);
      assert(controllerPatterns.has(pattern));
      assert.equal(rpcMethod, pattern);
      break;
    case "runtime-controller":
      assert.equal(rpcService, service);
      assert(runtimePatterns.has(pattern));
      assert.equal(rpcMethod, pattern);
      break;
    case "antnest-runtime-egress":
      assert.equal(rpcService, "runtime-egress.control");
      assert(egressMethods.has(pattern));
      assert.equal(rpcMethod, egressMethods.get(pattern));
      break;
    default:
      assert.fail("ordinary HTTP is not a receiving RPC content boundary");
  }
}
