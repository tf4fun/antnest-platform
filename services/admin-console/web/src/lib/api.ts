import { csrfFromCookie } from "./forms";
import type { AvailabilityChange, AvailabilityReceipt, CatalogKind, ExecutionSynchronization } from "./catalog-availability";
import { decodeNetworkAssignment, decodeNetworkPolicy, type PendingNetwork } from "./network-policy";
import { invalidatesBrowserSession } from "./session-errors";
import type { SkillPage, SkillReference, SkillVersion, SkillVersionPage, SkillSourcePage, SkillSourcePreview, SkillSourceSelection, SkillSourcePromotion } from "./skills";
import { auditQuery, type AuditFilters, type AuditPage, type ExecutionAuditSummary, type ExecutionAuditDetail, type ExecutionAuditEvent, type ExecutionAuditPermission } from "./execution-audit";
import {
  agentPagePath,
  catalogPagePath,
  type AgentPageOptions,
  type CatalogPageOptions,
} from "./pagination";
import type {
  Agent,
  AgentSkillPreparation,
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
  ManagedMCPServerWrite,
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
    public readonly details?: RemoteErrorBody,
  ) {
    super(message);
    this.name = "APIError";
  }
}

let browserSession = Symbol();
let commandPrincipal = "uninitialized";

export function resetSessionRequests(principal?: Pick<Session["principal"], "organization_id" | "user_id" | "membership_id">): void {
  browserSession = Symbol();
  commandPrincipal = principal ? JSON.stringify([principal.organization_id, principal.user_id, principal.membership_id]) : crypto.randomUUID();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestSession = browserSession;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !(init.body instanceof FormData)) {
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
    throw new APIError(response.status, code, message, remote);
  }
  if (requestSession === browserSession && !["GET", "HEAD", "OPTIONS"].includes(method) &&
      (/^\/api\/admin\/(provider-connections|model-profiles|templates)(\/|$)/.test(path) ||
        /^\/api\/admin\/agents($|\/[^/]+\/(rebuild|disable|enable|delete)$)/.test(path))) {
    window.dispatchEvent(new Event("antnest:configuration-changed"));
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

async function idempotentRequest<T>(scope: string, path: string, input: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  const requestSession = browserSession;
  const scopedIntent = `${commandPrincipal}:${scope}`;
  const storageKey = intentStorageKey(scopedIntent, input);
  // A changed command replaces the pending intent, even if an older body is used again later.
  const prefix = `antnest:lifecycle:${scopedIntent}:`;
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
      method,
      headers: { "Idempotency-Key": idempotencyKey },
      body: json(input),
    });
    if (browserSession === requestSession && sessionStorage.getItem(storageKey) === idempotencyKey) sessionStorage.removeItem(storageKey);
    return result;
  } catch (error) {
    if (error instanceof APIError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
      if (browserSession === requestSession && sessionStorage.getItem(storageKey) === idempotencyKey) sessionStorage.removeItem(storageKey);
    }
    throw error;
  }
}

export type CreateAgentInput = { owner_user_id: string; name: string; template_id: string; template_revision: number };

function pendingLifecycleKey(scope: string, input: unknown): string | null {
  return sessionStorage.getItem(intentStorageKey(`${commandPrincipal}:${scope}`, input));
}

async function skillUpload(skillID: string | undefined, file: File, expectedVersion?: number): Promise<SkillVersion> {
  if (file.size === 0 || file.size > 8 * 1024 * 1024) throw new Error("Choose a ZIP file of at most 8 MiB.");
  const bytes = await file.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
  const scope = `${commandPrincipal}:skill:${skillID ?? "new"}:${expectedVersion ?? 0}`;
  const storageKey = `antnest:skill:${scope}:${digest}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) { key = crypto.randomUUID(); sessionStorage.setItem(storageKey, key); }
  const form = new FormData();
  form.append("artifact", file);
  if (skillID) form.append("expected_version", String(expectedVersion));
  const path = skillID ? `/api/admin/skills/${encodeURIComponent(skillID)}/versions` : "/api/admin/skills";
  const session = browserSession;
  try {
    const result = await request<SkillVersion>(path, { method: "POST", headers: { "Idempotency-Key": key }, body: form });
    if (session === browserSession && sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey);
    return result;
  } catch (cause) {
    if (cause instanceof APIError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) {
      if (session === browserSession && sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey);
    }
    throw cause;
  }
}

async function skillArtifact(skillID: string, version: number): Promise<Blob> {
  const path = `/api/admin/skills/${encodeURIComponent(skillID)}/versions/${version}/artifact`;
  const session = browserSession;
  const response = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/zip" } });
  if (!response.ok) {
    let failure: RemoteErrorBody = {};
    try { failure = await response.json() as RemoteErrorBody; } catch { /* bounded BFF failure fallback */ }
    const code = typeof failure.code === "string" ? failure.code : "request_failed";
    notifySessionFailure(session, path, response.status, code);
    throw new APIError(response.status, code, typeof failure.message === "string" ? failure.message : "Download failed.", failure);
  }
  return response.blob();
}

function oneShotCommand<T>(path: string, input: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: json(input),
  });
}

export const api = {
  searchSkillSources: (query: string, signal?: AbortSignal) => request<SkillSourcePage>("/api/admin/skill-sources/search", { method: "POST", body: json({ query, limit: 50 }), signal }),
  previewSkillSource: (selection: SkillSourceSelection, signal?: AbortSignal) => request<SkillSourcePreview>("/api/admin/skill-sources/preview", { method: "POST", body: json(selection), signal }),
  promoteSkillSource: (selection: SkillSourcePromotion) => idempotentRequest<SkillVersion>(`skill-promotion:${selection.skill_ref.agent_id}:${selection.skill_ref.name}`, "/api/admin/skill-sources/promote", selection),
  skills: (afterID?: string) => request<SkillPage>(`/api/admin/skills${afterID ? `?after_id=${encodeURIComponent(afterID)}` : ""}`),
  skillVersions: (skillID: string, afterVersion?: number) => request<SkillVersionPage>(`/api/admin/skills/${encodeURIComponent(skillID)}/versions${afterVersion ? `?after_version=${afterVersion}` : ""}`),
  publishSkill: (file: File) => skillUpload(undefined, file),
  publishSkillVersion: (skillID: string, expectedVersion: number, file: File) => skillUpload(skillID, file, expectedVersion),
  skillArtifact,
  setCatalogAvailability: (kind: CatalogKind, id: string, input: AvailabilityChange) =>
    idempotentRequest<AvailabilityReceipt>(`availability:${kind}:${id}`, `/api/admin/${kind}/${encodeURIComponent(id)}/availability`, input, "PUT"),
  executionSynchronization: (signal?: AbortSignal) =>
    request<{ synchronization: ExecutionSynchronization | null }>("/api/admin/execution-synchronization", { signal }),
  executionAudits: (filters: AuditFilters, cursor?: string, signal?: AbortSignal) =>
    request<AuditPage<ExecutionAuditSummary>>(`/api/admin/execution-audits?${auditQuery({ ...filters, cursor })}`, { signal }),
  executionAudit: (runID: string, signal?: AbortSignal) =>
    request<ExecutionAuditDetail>(`/api/admin/execution-audits/${encodeURIComponent(runID)}`, { signal }),
  executionAuditEvents: (runID: string, cursor?: string, signal?: AbortSignal) =>
    request<AuditPage<ExecutionAuditEvent>>(`/api/admin/execution-audits/${encodeURIComponent(runID)}/events?${auditQuery({ stream: "execution", cursor })}`, { signal }),
  executionAuditPermissions: (runID: string, cursor?: string, signal?: AbortSignal) =>
    request<AuditPage<ExecutionAuditPermission>>(`/api/admin/execution-audits/${encodeURIComponent(runID)}/events?${auditQuery({ stream: "permissions", cursor })}`, { signal }),
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
  provider: (id: string, signal?: AbortSignal) => request<ProviderConnection>(`/api/admin/provider-connections/${encodeURIComponent(id)}`, { signal }),
  createProvider: (input: { provider_key: string; display_name: string; base_url: string; credential: ProviderCredential; models: ProviderModelInput[] }) =>
    idempotentRequest<ProviderConnection>("create-provider", "/api/admin/provider-connections", input),
  rotateProviderCredential: (id: string, input: { expected_version: string; credential: ProviderCredential }) =>
    idempotentRequest<ProviderConnection>(`provider-credential:${id}`, `/api/admin/provider-connections/${encodeURIComponent(id)}/credentials`, input),
  modelCatalog: () => request<ModelCatalog>("/api/admin/model-catalog"),
  discoverProviderModels: (id: string, signal?: AbortSignal) => request<import("./types").ModelDiscovery>(`/api/admin/provider-connections/${encodeURIComponent(id)}/models/discovery`, { signal }),
  discoverDraftModels: (draft: import("./types").ProviderDiscoveryDraft, signal?: AbortSignal) =>
    request<import("./types").ModelDiscovery>("/api/admin/provider-models/discovery", {method: "POST", body: JSON.stringify(draft), signal}),
  models: (options: CatalogPageOptions = {}) =>
    request<ModelProfileList>(catalogPagePath("/api/admin/model-profiles", options)),
  model: (modelProfileID: string, signal?: AbortSignal) =>
    request<ModelProfile>(`/api/admin/model-profiles/${encodeURIComponent(modelProfileID)}`, { signal }),
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
  template: (templateID: string, signal?: AbortSignal) =>
    request<AgentTemplate>(`/api/admin/templates/${encodeURIComponent(templateID)}`, { signal }),
  templateRevision: (templateID: string, revision: number) =>
    request<AgentTemplate>(
      `/api/admin/templates/${encodeURIComponent(templateID)}/revisions/${encodeURIComponent(String(revision))}`,
    ),
  createTemplate: (input: {
    fallback_model_profile_ids?: string[];
    name: string;
    model_profile_id: string;
    system_prompt: string;
    max_model_requests: number;
    skill_refs?: SkillReference[];
    runtime?: { image_ref?: string; mcp_servers?: ManagedMCPServerWrite[] };
  }) => idempotentRequest<AgentTemplate>("create-template", "/api/admin/templates", input),
  reviseTemplate: (templateID: string, input: {
    fallback_model_profile_ids?: string[];
    name: string;
    model_profile_id: string;
    system_prompt: string;
    max_model_requests: number;
    skill_refs?: SkillReference[];
    runtime: {
      image_ref: string;
      resources: { memory_bytes: number; pids_limit: number; tmpfs_bytes: number };
      mcp_servers?: ManagedMCPServerWrite[];
    };
  }) => idempotentRequest<AgentTemplate>(
    `revise-template:${templateID}`,
    `/api/admin/templates/${encodeURIComponent(templateID)}/revisions`,
    input,
  ),
  agents: (options: AgentPageOptions = {}) => request<AgentList>(agentPagePath(options)),
  agent: (agentID: string) => request<Agent>(`/api/admin/agents/${encodeURIComponent(agentID)}`),
  createAgent: (input: CreateAgentInput) => idempotentRequest<CreateAgentResult>("create-agent", "/api/admin/agents", input),
  agentSkillPreparationForCreate: (input: CreateAgentInput) => {
    const key = pendingLifecycleKey("create-agent", input);
    return key ? request<AgentSkillPreparation>("/api/admin/agent-skill-preparations/by-idempotency-key", { headers: { "Idempotency-Key": key } }) : Promise.resolve(undefined);
  },
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
  agentSkillPreparationForLifecycle: (
    agentID: string,
    action: "rebuild" | "enable",
    input: Record<string, unknown>,
    afterOperation = "",
  ) => {
    const key = pendingLifecycleKey(`${action}:${agentID}:after:${afterOperation}`, input);
    return key ? request<AgentSkillPreparation>("/api/admin/agent-skill-preparations/by-idempotency-key", { headers: { "Idempotency-Key": key } }) : Promise.resolve(undefined);
  },
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
