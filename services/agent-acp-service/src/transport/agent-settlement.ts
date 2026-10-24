import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAgentSettlement, type AgentSettlementRequest } from "../domain/agent-settlement.js";
import { DomainError } from "../domain/errors.js";
import type { AgentSettlementPort } from "../ports/agent-settlement.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError, rpcContent } from "../telemetry/diagnostics.js";
import { readRpcRequest, rpcJson, RpcRequestError } from "./rpc-request.js";
import { httpFailure } from "./public-error.js";

export const AGENT_SETTLEMENT_PATH = "/rpc/agent-acp/settle-agent";

export async function settleAgent(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentSettlementPort | undefined,
  maxBytes: number,
  ready: () => Promise<boolean>,
  forward?: (input: AgentSettlementRequest, signal: AbortSignal) => Promise<boolean>,
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
    if (await forward?.(input, disconnected.signal)) return;
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

export function settlementError(error: unknown) {
  if (error instanceof RpcRequestError) return httpFailure(error.code);
  if (error instanceof DomainError && error.code === "invalid_agent_settlement")
    return httpFailure(error.code);
  if (error instanceof DomainError && error.code === "agent_operation_conflict")
    return httpFailure(error.code);
  return httpFailure("settlement_unavailable");
}
