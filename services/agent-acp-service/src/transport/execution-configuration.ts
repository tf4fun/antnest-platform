import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../domain/errors.js";
import type { ExecutionConfigurationPort } from "../ports/execution-configuration.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError } from "../telemetry/diagnostics.js";
import { readRpcRequest, rpcJson, RpcRequestError } from "./rpc-request.js";

export const EXECUTION_CONFIGURATION_PATH = "/rpc/agent-acp/apply-execution-snapshot";

export async function applyExecutionConfiguration(
  request: IncomingMessage,
  response: ServerResponse,
  publisher: ExecutionConfigurationPort | undefined,
  maxBytes: number,
): Promise<void> {
  const span = activeHttpSpan();
  span?.setAttributes({
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": "apply_execution_snapshot",
  });
  try {
    const input = await readRpcRequest(request, maxBytes);
    if (publisher === undefined)
      throw new Error("Execution configuration publisher is unavailable");
    const applied = await publisher.apply(input);
    span?.setAttributes({
      "antnest.organization.id": applied.organization_id,
      "antnest.configuration.revision": applied.applied_revision,
    });
    rpcJson(response, 200, applied);
  } catch (error) {
    if (span !== undefined) recordBoundaryError(span, error, "configuration.apply");
    const failure = configurationError(error);
    response.setHeader("Connection", "close");
    rpcJson(response, failure.status, failure.body);
  }
}

function configurationError(error: unknown) {
  if (error instanceof RpcRequestError) {
    const code =
      error.status === 400
        ? "invalid_execution_configuration"
        : error.status === 413
          ? "configuration_too_large"
          : error.code;
    return {
      status: error.status,
      body: {
        code,
        message: error.status === 400 ? "Invalid execution configuration" : error.message,
        retryable: false,
      },
    };
  }
  if (error instanceof DomainError && error.code === "invalid_execution_configuration") {
    return {
      status: 400,
      body: { code: error.code, message: "Invalid execution configuration", retryable: false },
    };
  }
  if (error instanceof DomainError && error.code === "configuration_conflict") {
    return {
      status: 409,
      body: {
        code: error.code,
        message: "Execution configuration revision conflicts with current state",
        retryable: false,
      },
    };
  }
  return {
    status: 503,
    body: {
      code: "configuration_unavailable",
      message: "Execution configuration could not be applied",
      retryable: true,
    },
  };
}
