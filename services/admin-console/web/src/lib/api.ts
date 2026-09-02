import { csrfFromCookie } from "./forms";
import type {
  Agent,
  AgentEventList,
  AgentList,
  AgentTemplate,
  CreateAgentResult,
  Directory,
  LifecycleOperation,
  ModelProfile,
  ModelProfileList,
  Overview,
  RemoteErrorBody,
  Session,
  TemplateList,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new APIError(response.status, "invalid_response", "The server returned an invalid response.");
  }
  if (!response.ok) {
    const remote = body as RemoteErrorBody;
    if (response.status === 401 && path.startsWith("/api/admin/")) {
      window.dispatchEvent(new Event("antnest:session-expired"));
    }
    throw new APIError(response.status, remote.code ?? "request_failed", remote.message ?? "Request failed.");
  }
  return body as T;
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

async function lifecycleRequest<T>(scope: string, path: string, input: unknown): Promise<T> {
  const storageKey = intentStorageKey(scope, input);
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
    if (error instanceof APIError && error.status < 500 && ![408, 429].includes(error.status)) {
      sessionStorage.removeItem(storageKey);
    }
    throw error;
  }
}

export const api = {
  session: () => request<Session>("/api/session"),
  login: (organization_slug: string, email: string, password: string) =>
    request<Session>("/api/session/login", {
      method: "POST",
      body: json({ organization_slug, email, password }),
    }),
  logout: () => request<void>("/api/session", { method: "DELETE" }),
  overview: () => request<Overview>("/api/admin/overview"),
  directory: () => request<Directory>("/api/admin/directory"),
  models: () => request<ModelProfileList>("/api/admin/model-profiles"),
  createModel: (input: {
    profile_key: string;
    display_name: string;
    api_key: string;
    model: {
      base_url: string;
      model: string;
      context_window: number;
      max_output_tokens: number;
      supports_images: boolean;
    };
  }) => request<ModelProfile>("/api/admin/model-profiles", { method: "POST", body: json(input) }),
  templates: () => request<TemplateList>("/api/admin/templates"),
  createTemplate: (input: {
    template_key: string;
    name: string;
    model_profile_revision_id: string;
    system_prompt: string;
    max_model_requests: number;
    runtime?: { image_ref?: string };
  }) => request<AgentTemplate>("/api/admin/templates", { method: "POST", body: json(input) }),
  agents: (includeDeleted = false) =>
    request<AgentList>(`/api/admin/agents${includeDeleted ? "?include_deleted=true" : ""}`),
  agent: (agentID: string) => request<Agent>(`/api/admin/agents/${encodeURIComponent(agentID)}`),
  createAgent: (input: {
    owner_user_id: string;
    name: string;
    template_id: string;
    template_revision: number;
  }) => lifecycleRequest<CreateAgentResult>("create", "/api/admin/agents", input),
  lifecycle: (
    agentID: string,
    action: "rebuild" | "disable" | "enable" | "delete",
    input: Record<string, unknown> = {},
  ) =>
    lifecycleRequest<LifecycleOperation>(
      `${action}:${agentID}`,
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
