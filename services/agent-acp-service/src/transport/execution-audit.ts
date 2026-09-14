import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { DomainError } from "../domain/errors.js";
import type { ExecutionAuditPort } from "../ports/execution-audit.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError, rpcContent } from "../telemetry/diagnostics.js";
import { readRpcRequest, rpcJson, RpcRequestError } from "./rpc-request.js";
import { trustedAuditPrincipal } from "./trusted-identity.js";

const routes = new Map<string, { method: keyof ExecutionAuditPort; name: string }>([
  ["/rpc/agent-acp/list-execution-audits", { method: "list", name: "list_execution_audits" }],
  ["/rpc/agent-acp/get-execution-audit", { method: "get", name: "get_execution_audit" }],
  ["/rpc/agent-acp/list-execution-events", { method: "events", name: "list_execution_events" }],
]);
export function executionAuditRoute(path: string | undefined) {
  return routes.get(path ?? "");
}

export async function serveExecutionAudit(
  request: IncomingMessage,
  response: ServerResponse,
  route: { method: keyof ExecutionAuditPort; name: string },
  service: ExecutionAuditPort | undefined,
  maxBytes: number,
  ready: () => Promise<boolean>,
): Promise<void> {
  const disconnected = new AbortController();
  const onClose = () => disconnected.abort();
  response.once("close", onClose);
  const span = activeHttpSpan();
  span?.setAttributes({
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": route.name,
  });
  try {
    const principal = trustedAuditPrincipal(request.headers);
    if (principal === null)
      throw new RpcRequestError(401, "access_denied", "Trusted management identity is required");
    span?.setAttribute("antnest.organization.id", principal.organizationId);
    const input = await readRpcRequest(request, maxBytes);
    if (span !== undefined) rpcContent(span, "request", input);
    if (service === undefined || !(await ready())) throw new Error("Audit service is unavailable");
    const result = await service[route.method](principal, input, disconnected.signal);
    disconnected.signal.throwIfAborted();
    if (span !== undefined) rpcContent(span, "response", result);
    rpcJson(response, 200, result);
  } catch (error) {
    if (disconnected.signal.aborted) return;
    const failure = auditFailure(error);
    if (span !== undefined) {
      recordBoundaryError(span, error, "agent.execution_audit");
      rpcContent(span, "response", failure.body);
    }
    response.setHeader("Connection", "close");
    rpcJson(response, failure.status, failure.body);
  } finally {
    response.off("close", onClose);
  }
}

function auditFailure(error: unknown) {
  if (error instanceof RpcRequestError)
    return {
      status: error.status,
      body: { code: error.code, message: error.message, retryable: false },
    };
  if (error instanceof ZodError)
    return {
      status: 400,
      body: { code: "invalid_request", message: "Invalid audit query", retryable: false },
    };
  if (error instanceof DomainError) {
    const status = new Map([
      ["access_denied", 403],
      ["audit_not_found", 404],
      ["invalid_cursor", 400],
      ["invalid_request", 400],
    ]).get(error.code);
    if (status !== undefined)
      return { status, body: { code: error.code, message: error.message, retryable: false } };
  }
  return {
    status: 503,
    body: {
      code: "execution_audit_unavailable",
      message: "Execution audit is unavailable",
      retryable: true,
    },
  };
}
