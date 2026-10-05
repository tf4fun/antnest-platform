import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RuntimeConnections } from "../../../../services/agent-acp-service/src/adapters/runtime-connections.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

/** An isolated protocol peer's own CSPRNG authority, never a deployed credential. */
export function runtimeAuthority(
  endpoint: URL,
  executionId = "execution-1",
  scope?: { organizationId: string; agentId: string },
) {
  const configuration = executionConfiguration();
  if (scope) {
    configuration.organization_id = scope.organizationId;
    configuration.agents[0]!.agent_id = scope.agentId;
  }
  const runtime = configuration.agents[0]!.runtime!;
  runtime.runtime_revision = "rtv_" + randomBytes(16).toString("hex");
  runtime.connection_id = "rci_" + randomBytes(16).toString("hex");
  runtime.credential!.token = randomBytes(32).toString("base64url");
  runtime.runtime_execution_id = executionId;
  runtime.mcp_endpoint = endpoint.href;
  const privateConfiguration = parseExecutionConfiguration(configuration);
  const connections = new RuntimeConnections({
    authMode: "token",
    allowInsecureTransport: "true",
  });
  connections.prepare(privateConfiguration).commit();
  const binding = resolveExecutionConfiguration(
    publicExecutionConfiguration(privateConfiguration),
    { ...executionIdentity(), ...scope },
    {},
  ).runtime;
  return {
    connections,
    binding,
    configuration: privateConfiguration,
    runtime,
    admit(request: IncomingMessage, response: ServerResponse) {
      if (
        request.headers["antnest-service-authorization"] !==
          "Bearer " + runtime.credential!.token ||
        request.headers["x-antnest-expected-execution-id"] !==
          binding.executionId
      ) {
        response
          .writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="antnest-service"',
          })
          .end(
            JSON.stringify({
              code: "runtime_unauthorized",
              message: "Runtime request rejected",
              retryable: false,
            }),
          );
        return false;
      }
      return true;
    },
  };
}
