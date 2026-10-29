import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../domain/errors.js";
import type { ExecutionConfigurationPort } from "../ports/execution-configuration.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError } from "../telemetry/diagnostics.js";
import { readRpcRequest, rpcJson, RpcRequestError } from "./rpc-request.js";
import { httpFailure } from "./public-error.js";

export const EXECUTION_CONFIGURATION_PATH = "/rpc/agent-acp/apply-execution-snapshot";
export const EXECUTION_DELTA_PATH = "/rpc/agent-acp/apply-execution-delta";
export const EXECUTION_DIGEST_PATH = "/rpc/agent-acp/get-execution-digest";

export async function applyExecutionConfiguration(
  request: IncomingMessage,
  response: ServerResponse,
  publisher: ExecutionConfigurationPort | undefined,
  maxBytes: number,
): Promise<void> {
  return executionConfiguration(request, response, publisher, maxBytes, "snapshot");
}

export async function applyExecutionDelta(
  request: IncomingMessage,
  response: ServerResponse,
  publisher: ExecutionConfigurationPort | undefined,
  maxBytes: number,
): Promise<void> {
  return executionConfiguration(request, response, publisher, maxBytes, "delta");
}

export async function getExecutionDigest(
  request: IncomingMessage,
  response: ServerResponse,
  publisher: ExecutionConfigurationPort | undefined,
  maxBytes: number,
): Promise<void> {
  return executionConfiguration(request, response, publisher, maxBytes, "digest");
}

async function executionConfiguration(
  request: IncomingMessage,
  response: ServerResponse,
  publisher: ExecutionConfigurationPort | undefined,
  maxBytes: number,
  operation: "snapshot" | "delta" | "digest",
): Promise<void> {
  const span = activeHttpSpan();
  span?.setAttributes({
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method":
      operation === "snapshot"
        ? "apply_execution_snapshot"
        : operation === "delta"
          ? "apply_execution_delta"
          : "get_execution_digest",
  });
  try {
    const input = await readRpcRequest(request, maxBytes);
    if (publisher === undefined)
      throw new Error("Execution configuration publisher is unavailable");
    const applied =
      operation === "snapshot"
        ? await publisher.apply(input)
        : operation === "delta"
          ? await publisher.applyDelta?.(input)
          : await publisher.getDigest?.(input);
    if (applied === undefined) throw new Error("Execution configuration publisher is unavailable");
    if (operation !== "digest" && "applied_revision" in applied)
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
    return httpFailure(code);
  }
  if (error instanceof DomainError && error.code === "invalid_execution_configuration") {
    return httpFailure(error.code);
  }
  if (error instanceof DomainError && error.code === "configuration_conflict") {
    return httpFailure(error.code);
  }
  if (error instanceof DomainError && error.code === "configuration_base_mismatch") {
    return httpFailure(error.code);
  }
  return httpFailure("configuration_unavailable");
}
