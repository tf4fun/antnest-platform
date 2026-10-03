import type { IncomingMessage } from "node:http";
import { type ServiceAuthentication, fields } from "../adapters/service-authentication.js";
import {
  CALLER_CONTEXT_HEADER,
  CallerContextError,
  type CallerContextVerifier,
  type CallerClaims,
} from "../adapters/caller-context.js";
import { bindAuthenticatedRequest } from "./trusted-identity.js";

const workspace = ["edge-gateway", "agent-ui"];
const operationPaths = new Map([
  ["/rpc/agent-acp/apply-execution-snapshot", ["agent-controller"]],
  ["/rpc/agent-acp/settle-agent", ["agent-controller"]],
  ["/internal/skill-sources/inspect", ["skill-registry"]],
  ["/internal/skill-sources/artifact", ["skill-registry"]],
]);
const audits = new Set([
  "/rpc/agent-acp/list-execution-audits",
  "/rpc/agent-acp/get-execution-audit",
  "/rpc/agent-acp/list-execution-events",
]);
export type AuthenticationFailure = { status: number; code: string; challenge?: string };

export class RequestAuthentication {
  public constructor(
    public readonly workload: ServiceAuthentication,
    private readonly verifier: CallerContextVerifier,
  ) {}
  public async admit(
    request: IncomingMessage,
    upgrade = false,
  ): Promise<{ claims?: CallerClaims } | AuthenticationFailure> {
    if (!upgrade && request.method === "GET" && request.url === "/status") return {};
    const policy = routePolicy(request, upgrade);
    const admitted = this.workload.authenticate(request, policy.callers);
    if (admitted.code !== null)
      return {
        status: admitted.http_status,
        code: admitted.code,
        ...(admitted.www_authenticate === null ? {} : { challenge: admitted.www_authenticate }),
      };
    if (admitted.caller === null) return { status: 401, code: "service_unauthenticated" };
    if (!policy.context) {
      bindAuthenticatedRequest(request, admitted.caller);
      return {};
    }
    const tokens = fields(request).filter(
      (field) => field.name.toLowerCase() === CALLER_CONTEXT_HEADER.toLowerCase(),
    );
    if (tokens.length !== 1) return { status: 401, code: "caller_context_invalid" };
    try {
      const claims = await this.verifier.verify(
        tokens[0]!.value,
        policy.agent === undefined ? { requireAgent: !policy.audit } : { agent: policy.agent },
      );
      for (const name of Object.keys(request.headers))
        if (name.toLowerCase().startsWith("x-antnest-")) delete request.headers[name];
      bindAuthenticatedRequest(request, admitted.caller, claims);
      return { claims };
    } catch (error) {
      if (error instanceof CallerContextError && error.code === "identity_dependency_unavailable")
        return { status: 503, code: error.code };
      return { status: 401, code: "caller_context_invalid" };
    }
  }
}

function routePolicy(
  request: IncomingMessage,
  upgrade: boolean,
): { callers: string[]; context: boolean; audit?: boolean; agent?: string } {
  const path = (request.url ?? "").split("?", 1)[0]!;
  if (upgrade)
    return {
      callers: path === request.url && ["/v1/acp", "/v2/acp"].includes(path) ? workspace : [],
      context: true,
    };
  if (request.method === "POST" && request.url === path && operationPaths.has(path))
    return { callers: operationPaths.get(path)!, context: false };
  if (request.method === "POST" && request.url === path && audits.has(path))
    return { callers: ["admin-console"], context: true, audit: true };
  if (
    path === "/v1/acp" &&
    request.url === path &&
    ["POST", "GET", "DELETE"].includes(request.method ?? "")
  )
    return { callers: workspace, context: true };
  if (
    request.method === "POST" &&
    request.url === path &&
    [
      "/rpc/agent-acp/get-agent-execution-state",
      "/rpc/agent-acp/watch-agent-execution-state",
    ].includes(path)
  )
    return { callers: workspace, context: true };
  if (request.method === "GET") {
    const agent =
      /^\/rpc\/agent-acp\/workspace\/agents\/([^/]+)\/(?:learning-status|learning-changes)$/u.exec(
        path,
      )?.[1];
    if (agent) {
      try {
        return { callers: workspace, context: true, agent: decodeURIComponent(agent) };
      } catch {
        /* deny below */
      }
    }
    if (/^\/rpc\/agent-acp\/workspace\/sessions\/[^/]+\/(?:execution|intents\/[^/]+)$/u.test(path))
      return { callers: workspace, context: true };
  }
  return { callers: [], context: false };
}
