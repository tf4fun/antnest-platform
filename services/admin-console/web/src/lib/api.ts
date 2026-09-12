import { csrfFromCookie } from "./forms";
import { decodeNetworkAssignment, decodeNetworkPolicy, type PendingNetwork } from "./network-policy";
import { invalidatesBrowserSession } from "./session-errors";
import {
  agentPagePath,
  catalogPagePath,
  type AgentPageOptions,
  type CatalogPageOptions,
} from "./pagination";
import type {
  Agent,
  AgentEventList,
  AgentList,
  AgentTemplate,
  CreateAgentResult,
  CurrentAccountResult,
  Directory,
  DirectoryMember,
  DirectoryMembership,
  LifecycleOperation,
  LoginMethodList,
  ModelCatalog,
  ModelProfile,
  ModelProfileList,
  ModelParameters,
  ProviderConnection,
  ProviderConnectionList,
  ProviderCredential,
  ProviderModelInput,
  ManagedMCPServer,
  Overview,
  OIDCLoginStart,
  OIDCProviderList,
  OIDCProviderResult,
  RemoteErrorBody,
  Session,
  SCIMTokenIssue,
  SCIMTokenList,
  TemplateList,
  TemplateDefaults,
} from "./types";

export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "APIError";
  }
}

let browserSession = Symbol();

export function resetSessionRequests(): void {
  browserSession = Symbol();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestSession = browserSession;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const token = csrfFromCookie(document.cookie);
    if (token) headers.set("X-Antnest-CSRF-Token", token);
  }
  const response = await fetch(path, { ...init, method, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  let body: unknown;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    notifySessionFailure(requestSession, path, response.status);
    throw new APIError(response.status, "invalid_response", "The server returned an invalid response.");
  }
  if (!response.ok) {
    const remote = (body !== null && typeof body === "object" ? body : {}) as RemoteErrorBody;
    const code = typeof remote.code === "string" ? remote.code : "request_failed";
    const message = typeof remote.message === "string" ? remote.message : "Request failed.";
    notifySessionFailure(requestSession, path, response.status, code);
    throw new APIError(response.status, code, message);
  }
  return body as T;
}

function notifySessionFailure(requestSession: symbol, path: string, status: number, code?: string): void {
  if (requestSession === browserSession && invalidatesBrowserSession(path, status, code)) {
    window.dispatchEvent(new Event("antnest:session-expired"));
  }
}

const json = (value: unknown) => JSON.stringify(value);

function intentStorageKey(scope: string, input: unknown): string {
  const value = `${scope}:${json(input)}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `antnest:lifecycle:${scope}:${(hash >>> 0).toString(16)}`;
}

async function idempotentRequest<T>(scope: string, path: string, input: unknown): Promise<T> {
  const storageKey = intentStorageKey(scope, input);
  // A changed command replaces the pending intent, even if an older body is used again later.
  const prefix = `antnest:lifecycle:${scope}:`;
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(prefix) && key !== storageKey) sessionStorage.removeItem(key);
  }
  let idempotencyKey = sessionStorage.getItem(storageKey);
  if (!idempotencyKey) {
    idempotencyKey = crypto.randomUUID();
    sessionStorage.setItem(storageKey, idempotencyKey);
  }
  try {
    const result = await request<T>(path, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: json(input),
    });
    sessionStorage.removeItem(storageKey);
    return result;
  } catch (error) {
    if (error instanceof APIError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
      sessionStorage.removeItem(storageKey);
    }
    throw error;
  }
}

function oneShotCommand<T>(path: string, input: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: json(input),
  });
}

export const api = {
  networkPolicy: async (agentID: string, signal?: AbortSignal) => decodeNetworkPolicy(await request<unknown>(`/api/admin/agents/${encodeURIComponent(agentID)}/network-policy`, { signal }), agentID),
  setNetworkPolicy: async (agentID: string, intent: PendingNetwork, scope: string) => decodeNetworkAssignment(await request<unknown>(`/api/admin/agents/${encodeURIComponent(agentID)}/network-policy`, {
    method: "PUT", headers: { "Idempotency-Key": intent.idempotency_key, "X-Antnest-Expected-Principal": encodeURIComponent(scope) },
    body: json({ action: intent.action, expected_resource_version: intent.expected_resource_version }),
  }), agentID, intent),
  session: () => request<Session>("/api/session"),
  loginMethods: (organization_slug: string) => request<LoginMethodList>("/api/session/login-methods", {
    method: "POST",
    body: json({ organization_slug }),
  }),
  startOIDCLogin: (organization_slug: string, provider_name: string) =>
    request<OIDCLoginStart>("/api/session/oidc/start", {
      method: "POST",
      body: json({ organization_slug, provider_name }),
    }),
  login: (organization_slug: string, email: string, password: string) =>
    request<Session>("/api/session/login", {
      method: "POST",
      body: json({ organization_slug, email, password }),
    }),
  logout: () => request<void>("/api/session", { method: "DELETE" }),
  currentAccount: () => request<CurrentAccountResult>("/api/admin/account"),
  changeOwnPassword: (current_password: string, new_password: string) =>
    oneShotCommand<{ status: "changed" }>("/api/admin/account/password", {
      current_password,
      new_password,
    }),
  overview: (signal?: AbortSignal) => request<Overview>("/api/admin/overview", { signal }),
  directory: () => request<Directory>("/api/admin/directory"),
  createLocalUser: (input: {
    email: string;
    display_name: string;
    password: string;
    role: "member" | "admin";
  }) => idempotentRequest<DirectoryMember>("create-local-user", "/api/admin/directory/users", input),
  updateMembership: (membershipID: string, input: {
    email: string;
    display_name: string;
    role: "member" | "admin";
    active: boolean;
  }) => idempotentRequest<{ membership: DirectoryMembership }>(
    `update-membership:${membershipID}`,
    `/api/admin/directory/memberships/${encodeURIComponent(membershipID)}`,
    input,
  ),
  setUserActive: (userID: string, active: boolean) =>
    idempotentRequest<{ status: string }>(
      `set-user-active:${userID}`,
      `/api/admin/directory/users/${encodeURIComponent(userID)}/active`,
      { active },
    ),
  oidcProviders: () => request<OIDCProviderList>("/api/admin/provisioning/oidc-providers"),
  upsertOIDCProvider: (input: {
    name: string;
    issuer: string;
    client_id: string;
    client_secret: string;
    scopes: string[];
    enabled: boolean;
  }) => idempotentRequest<OIDCProviderResult>(
    `upsert-oidc-provider:${input.name}`,
    "/api/admin/provisioning/oidc-providers",
    input,
  ),
  setOIDCProviderEnabled: (name: string, enabled: boolean) =>
    idempotentRequest<OIDCProviderResult>(
      `set-oidc-provider-enabled:${name}`,
      `/api/admin/provisioning/oidc-providers/${encodeURIComponent(name)}/enabled`,
      { enabled },
    ),
  scimTokens: () => request<SCIMTokenList>("/api/admin/provisioning/scim-tokens"),
  issueSCIMToken: (input: {
    name: string;
    scopes: Array<"scim:read" | "scim:write">;
  }) => idempotentRequest<SCIMTokenIssue>("issue-scim-token", "/api/admin/provisioning/scim-tokens", input),
  revokeSCIMToken: (tokenID: string) => idempotentRequest<{ status: string }>(
    `revoke-scim-token:${tokenID}`,
    `/api/admin/provisioning/scim-tokens/${encodeURIComponent(tokenID)}/revoke`,
    {},
  ),
  providers: (options?: CatalogPageOptions) => request<ProviderConnectionList>(catalogPagePath("/api/admin/provider-connections", options)),
  provider: (id: string) => request<ProviderConnection>(`/api/admin/provider-connections/${encodeURIComponent(id)}`),
  createProvider: (input: { provider_key: string; display_name: string; base_url: string; credential: ProviderCredential; models: ProviderModelInput[] }) =>
    idempotentRequest<ProviderConnection>("create-provider", "/api/admin/provider-connections", input),
  rotateProviderCredential: (id: string, input: { expected_version: string; credential: ProviderCredential }) =>
    idempotentRequest<ProviderConnection>(`provider-credential:${id}`, `/api/admin/provider-connections/${encodeURIComponent(id)}/credentials`, input),
  modelCatalog: () => request<ModelCatalog>("/api/admin/model-catalog"),
  models: (options: CatalogPageOptions = {}) =>
    request<ModelProfileList>(catalogPagePath("/api/admin/model-profiles", options)),
  model: (modelProfileID: string) =>
    request<ModelProfile>(`/api/admin/model-profiles/${encodeURIComponent(modelProfileID)}`),
  createModel: (input: {
    display_name: string;
    provider_connection_id: string;
    model: ModelParameters;
  }) => idempotentRequest<ModelProfile>("create-model", "/api/admin/model-profiles", input),
  reviseModel: (modelProfileID: string, input: {
    expected_version: number;
    display_name: string;
    model: ModelParameters;
  }) => idempotentRequest<ModelProfile>(
    `revise-model:${modelProfileID}`,
    `/api/admin/model-profiles/${encodeURIComponent(modelProfileID)}/revisions`,
    input,
  ),
  templates: (options: CatalogPageOptions = {}) =>
    request<TemplateList>(catalogPagePath("/api/admin/templates", options)),
  templateDefaults: () => request<TemplateDefaults>("/api/admin/template-defaults"),
  template: (templateID: string) =>
    request<AgentTemplate>(`/api/admin/templates/${encodeURIComponent(templateID)}`),
  templateRevision: (templateID: string, revision: number) =>
    request<AgentTemplate>(
      `/api/admin/templates/${encodeURIComponent(templateID)}/revisions/${encodeURIComponent(String(revision))}`,
    ),
  createTemplate: (input: {
    name: string;
    model_profile_id: string;
    system_prompt: string;
    max_model_requests: number;
    runtime?: { image_ref?: string; mcp_servers?: ManagedMCPServer[] };
  }) => idempotentRequest<AgentTemplate>("create-template", "/api/admin/templates", input),
  reviseTemplate: (templateID: string, input: {
    name: string;
    model_profile_id: string;
    system_prompt: string;
    max_model_requests: number;
    runtime: {
      image_ref: string;
      resources: { memory_bytes: number; pids_limit: number; tmpfs_bytes: number };
      mcp_servers?: ManagedMCPServer[];
    };
  }) => idempotentRequest<AgentTemplate>(
    `revise-template:${templateID}`,
    `/api/admin/templates/${encodeURIComponent(templateID)}/revisions`,
    input,
  ),
  agents: (options: AgentPageOptions = {}) => request<AgentList>(agentPagePath(options)),
  agent: (agentID: string) => request<Agent>(`/api/admin/agents/${encodeURIComponent(agentID)}`),
  createAgent: (input: {
    owner_user_id: string;
    name: string;
    template_id: string;
    template_revision: number;
  }) => idempotentRequest<CreateAgentResult>("create-agent", "/api/admin/agents", input),
  lifecycle: (
    agentID: string,
    action: "rebuild" | "disable" | "enable" | "delete",
    input: Record<string, unknown> = {},
    afterOperation = "",
  ) =>
    idempotentRequest<LifecycleOperation>(
      `${action}:${agentID}:after:${afterOperation}`,
      `/api/admin/agents/${encodeURIComponent(agentID)}/${action}`,
      input,
    ),
  operation: (requestID: string) =>
    request<LifecycleOperation>(`/api/admin/operations/${encodeURIComponent(requestID)}`),
  events: (agentID: string, afterSequence = 0) =>
    request<AgentEventList>(
      `/api/admin/agents/${encodeURIComponent(agentID)}/events?after_sequence=${afterSequence}&limit=200`,
    ),
  eventStream: (agentID: string, afterSequence = 0) =>
    `/api/admin/agents/${encodeURIComponent(agentID)}/events/watch?after_sequence=${afterSequence}`,
};

export function errorMessage(error: unknown): string {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return "The request could not be completed.";
}
