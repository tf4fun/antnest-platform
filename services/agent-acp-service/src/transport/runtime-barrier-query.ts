import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../domain/errors.js";
import {
  parseRuntimeBarrierQuery,
  parseRuntimeBarrierQueryResult,
} from "../domain/runtime-barrier-query.js";
import type { RuntimeBarrierReader } from "../ports/runtime-barrier.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError, rpcContent } from "../telemetry/diagnostics.js";
import { readRpcRequest, rpcJson, RpcRequestError } from "./rpc-request.js";
import { httpFailure } from "./public-error.js";

export const RUNTIME_BARRIER_QUERY_PATH = "/rpc/agent-acp/get-runtime-barrier";

export async function serveRuntimeBarrierQuery(
  request: IncomingMessage,
  response: ServerResponse,
  reader: RuntimeBarrierReader | undefined,
  maxBytes: number,
  ready: () => Promise<boolean>,
): Promise<void> {
  const disconnected = new AbortController();
  const onClose = () => disconnected.abort();
  response.once("close", onClose);
  if (response.destroyed) onClose();
  const span = activeHttpSpan();
  try {
    span?.setAttributes({
      "rpc.system.name": "json-over-http",
      "rpc.service": "agent-acp",
      "rpc.method": "get_runtime_barrier",
    });
    disconnected.signal.throwIfAborted();
    const input = parseRuntimeBarrierQuery(await readRpcRequest(request, maxBytes));
    disconnected.signal.throwIfAborted();
    if (span !== undefined) rpcContent(span, "request", input);
    let available: boolean;
    try {
      available = await ready();
    } catch (cause) {
      throw new Error("Runtime barrier query readiness failed", { cause });
    }
    disconnected.signal.throwIfAborted();
    if (available !== true || reader === undefined)
      throw new Error("Runtime barrier reader is unavailable");
    const current = await reader.readCurrentBarrier(
      {
        organizationId: input.organization_id,
        agentId: input.agent_id,
        expectedRuntimeRevision: input.expected_runtime_revision,
      },
      disconnected.signal,
    );
    disconnected.signal.throwIfAborted();
    if (current.runtimeRevision !== input.expected_runtime_revision)
      throw new Error("Runtime barrier reader returned a different Runtime revision");
    const result = parseRuntimeBarrierQueryResult({
      organization_id: input.organization_id,
      agent_id: input.agent_id,
      runtime_revision: current.runtimeRevision,
      barrier:
        current.barrier === null
          ? null
          : {
              barrier_id: current.barrier.barrierId,
              reason: "runtime_barrier_required",
              runtime_execution_id: current.barrier.runtimeExecutionId,
            },
    });
    span?.setAttributes({
      "antnest.organization.id": input.organization_id,
      "antnest.agent.id": input.agent_id,
      "antnest.runtime.revision": result.runtime_revision,
    });
    if (span !== undefined) rpcContent(span, "response", result);
    rpcJson(response, 200, result);
  } catch (error) {
    if (disconnected.signal.aborted) return;
    const failure = queryFailure(error);
    if (span !== undefined) {
      recordBoundaryError(span, error, "agent.runtime_barrier_query");
      rpcContent(span, "response", failure.body);
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (!response.destroyed) response.setHeader("Connection", "close");
    rpcJson(response, failure.status, failure.body);
  } finally {
    response.off("close", onClose);
  }
}

function queryFailure(error: unknown) {
  if (error instanceof RpcRequestError) return httpFailure(error.code);
  if (error instanceof DomainError) {
    const known = [
      "invalid_request",
      "not_found",
      "configuration_conflict",
      "configuration_not_ready",
    ];
    if (known.includes(error.code)) return httpFailure(error.code);
  }
  return httpFailure("execution_state_unavailable");
}
