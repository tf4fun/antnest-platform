import type { IncomingMessage } from "node:http";
import { fields, type ServiceAuthentication } from "../adapters/service-authentication.ts";
import { CALLER_CONTEXT_HEADER, CallerContextError, type CallerContextVerifier } from "../adapters/caller-context.ts";
import type { Delegation } from "./trusted-identity.ts";
import { parseWorkspaceDocumentPath } from "../protocol/workspace-route.ts";

export type AuthenticationFailure = { status: number; code: string; challenge?: string };
type Policy = { known: boolean; context: boolean; agent?: string; json: boolean };
export class RequestAuthentication {
  public readonly workload: ServiceAuthentication;
  private readonly verifier: CallerContextVerifier;
  public constructor(workload: ServiceAuthentication, verifier: CallerContextVerifier) {
    this.workload = workload; this.verifier = verifier;
  }
  public async admit(request: IncomingMessage): Promise<{ policy: Policy; context?: Delegation } | AuthenticationFailure> {
    const policy = workspaceRoutePolicy(request.method ?? "GET", request.url ?? "");
    const admission = this.workload.authenticate(request, ["edge-gateway"]);
    if (admission.code !== null) return { status: admission.http_status, code: admission.code,
      ...(admission.www_authenticate === null ? {} : { challenge: admission.www_authenticate }) };
    if (!policy.known || !policy.context) return { policy };
    const tokens = fields(request).filter(field => field.name.toLowerCase() === CALLER_CONTEXT_HEADER.toLowerCase());
    if (tokens.length !== 1) return { status: 401, code: "caller_context_invalid" };
    try {
      const token = tokens[0]!.value;
      const claims = await this.verifier.verify(token, { agent: policy.agent });
      return { policy, context: { token, claims } };
    } catch (error) {
      if (error instanceof CallerContextError && error.code === "identity_dependency_unavailable")
        return { status: 503, code: error.code };
      return { status: 401, code: "caller_context_invalid" };
    }
  }
}

export function workspaceRoutePolicy(method: string, rawUrl: string): Policy {
  const unknown = { known: false, context: false, json: false };
  const path = rawUrl.split("?", 1)[0]!;
  if ((method === "GET" || method === "HEAD") && /^\/workspace\/assets\/[A-Za-z0-9_.-]+$/u.test(path))
    return { known: true, context: false, json: false };
  if ((method === "GET" || method === "HEAD") && rawUrl.startsWith("/workspace/")) {
    const route = parseWorkspaceDocumentPath(rawUrl);
    if (!route) return unknown;
    // HTML selection performs organization-scoped discovery only. Agent API
    // requests below carry the separate signed Agent grant from Gateway.
    return { known: true, context: true, json: false };
  }
  if (method === "GET" && path === "/api/app/workspace/v1/bootstrap")
    return { known: true, context: true, json: false };
  const match = /^\/api\/app\/workspace\/v1\/agents\/([^/]+)\/(.+)$/u.exec(path);
  if (!match) return unknown;
  let agent: string;
  try { agent = decodeURIComponent(match[1]!); } catch { return unknown; }
  if (!agent || /[\x00-\x1f\x7f]/u.test(agent)) return unknown;
  const suffix = match[2]!;
  const known = method === "GET"
    ? /^(?:events|view|sessions|sessions\/[^/]+\/(?:view|operations\/[^/]+|turns(?:\/[^/]+\/(?:content|process(?:\/[^/]+\/content)?))?))$/u.test(suffix)
    : method === "POST" && /^(?:commands|sessions|permissions\/[^/]+\/decision|sessions\/[^/]+\/(?:configuration|prompts|operations\/[^/]+\/cancel))$/u.test(suffix);
  return known ? { known: true, context: true, agent, json: method === "POST" } : unknown;
}
