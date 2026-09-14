import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAgentSettlement } from "../domain/agent-settlement.js";
import { DomainError } from "../domain/errors.js";
import type { AgentSettlementPort } from "../ports/agent-settlement.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError, rpcContent } from "../telemetry/diagnostics.js";
import { readRpcRequest, rpcJson, RpcRequestError } from "./rpc-request.js";

export const AGENT_SETTLEMENT_PATH = "/rpc/agent-acp/settle-agent";

export async function settleAgent(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentSettlementPort | undefined,
  maxBytes: number,
  ready: () => Promise<boolean>,
): Promise<void> {
  const span = activeHttpSpan();
  span?.setAttributes({
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": "settle_agent",
  });
  const disconnected = new AbortController();
  const onClose = () => disconnected.abort();
  response.once("close", onClose);
  try {
    const input = parseAgentSettlement(await readRpcRequest(request, maxBytes));
    if (span !== undefined) rpcContent(span, "request", input);
    if (service === undefined || !(await ready()))
      throw new Error("Settlement service is unavailable");
    const result = await service.settle(input, disconnected.signal);
    span?.setAttributes({
      "antnest.organization.id": input.organization_id,
      "antnest.agent.id": input.agent_id,
      "antnest.operation.id": input.operation_id,
      "antnest.configuration.revision": result.applied_revision,
      "antnest.settlement.outcome": result.outcome,
    });
    if (span !== undefined) rpcContent(span, "response", result);
    rpcJson(response, 200, result);
  } catch (error) {
    if (span !== undefined) recordBoundaryError(span, error, "agent.settle");
    const failure = settlementError(error);
    if (span !== undefined) rpcContent(span, "response", failure.body);
    if (!response.destroyed) response.setHeader("Connection", "close");
    rpcJson(response, failure.status, failure.body);
  } finally {
    response.off("close", onClose);
  }
}

function settlementError(error: unknown) {
  if (error instanceof RpcRequestError)
    return {
      status: error.status,
      body: { code: error.code, message: error.message, retryable: false },
    };
  if (error instanceof DomainError && error.code === "invalid_agent_settlement")
    return {
      status: 400,
      body: { code: error.code, message: "Invalid Agent settlement request", retryable: false },
    };
  if (error instanceof DomainError && error.code === "agent_operation_conflict")
    return {
      status: 409,
      body: {
        code: error.code,
        message: "Agent lifecycle operation no longer matches the applied configuration",
        retryable: false,
      },
    };
  return {
    status: 503,
    body: {
      code: "settlement_unavailable",
      message: "Agent execution could not be settled",
      retryable: true,
    },
  };
}
