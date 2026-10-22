import type { ContentBlock } from "@agentclientprotocol/sdk";
import { BrowserSessionChanged, type BrowserSessionClient, type BrowserRequest } from "./browser-session.ts";
import { validAgentView } from "../../server/src/protocol/agent-view-delta.ts";
import type { LearningStatus } from "../../server/src/protocol/learning-status.ts";
import { controlResultSchema, type ControlRequest, type ControlResult } from "../../server/src/protocol/workspace-commands.ts";

const base = "/api/app/workspace/v1";
const ordinaryTimeoutMs = 30_000;

export type WorkspaceRecovery = "refresh" | "query_operation" | "login" | "retry_read" | "none";
export type PromptAdmission = {
  intentId: string;
  expectedAppendVersion: number;
  historyToken: string;
  prompt: readonly ContentBlock[];
};
export type PromptAccepted = {
  operationId: string;
  acceptance: "bridge";
  phase: "dispatching";
};

export class WorkspaceApiError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly recovery: WorkspaceRecovery;
  readonly operationId?: string;
  constructor(
    message: string,
    status: number | undefined,
    code: string,
    recovery: WorkspaceRecovery,
    operationId?: string,
  ) {
    super(message);
    this.name = "WorkspaceApiError";
    this.status = status;
    this.code = code;
    this.recovery = recovery;
    this.operationId = operationId;
  }
}

export function isWorkspaceReadTimeout(cause: unknown): boolean {
  return cause instanceof WorkspaceApiError &&
    (cause.code === "workspace_request_timeout" ||
      cause.code === "workspace_deadline_exceeded");
}

type Options = {
  fetch?: typeof fetch;
  session: BrowserSessionClient;
  timeoutMs?: number;
};

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  ambiguousOperationId?: string;
};

const segment = (value: string) => encodeURIComponent(value);
const agentPath = (agentId: string) => `${base}/agents/${segment(agentId)}`;
const sessionPath = (agentId: string, sessionId: string) =>
  `${agentPath(agentId)}/sessions/${segment(sessionId)}`;

export class BridgeHttpClient {
  private readonly fetcher: typeof fetch;
  readonly session: BrowserSessionClient;
  private readonly timeoutMs: number;
  private binding: BrowserRequest | undefined;

  constructor(options: Options) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.session = options.session;
    this.timeoutMs = options.timeoutMs ?? ordinaryTimeoutMs;
  }

  /** A client never migrates old intentions into a replacement browser session. */
  private captureSession(): BrowserRequest {
    try {
      const current = this.session.capture();
      this.binding ??= current;
      this.session.assert(this.binding);
      return this.binding;
    } catch (cause) {
      if (cause instanceof BrowserSessionChanged) throw changedSession();
      throw cause;
    }
  }

  sessionCurrent(): boolean {
    return this.binding !== undefined && this.session.current(this.binding);
  }

  onSessionCancelled(cancel: () => void): () => void {
    return this.session.onCancel(this.captureSession(), cancel);
  }

  bootstrap(signal?: AbortSignal): Promise<unknown> {
    return this.request(`${base}/bootstrap`, { signal });
  }

  agentView(agentId: string, sessionId: string | null = null, signal?: AbortSignal): Promise<unknown> {
    const query = sessionId === null ? "" : `?${new URLSearchParams({ sessionId })}`;
    return this.request(`${agentPath(agentId)}/view${query}`, { signal });
  }

  async learningStatus(agentId: string, signal?: AbortSignal): Promise<LearningStatus> {
    const view = await this.request(`${agentPath(agentId)}/view?learningStatus=1`, { signal });
    const request = this.captureSession();
    if (!validAgentView(view) || view.agentId !== agentId || view.learningStatus == null)
      throw new WorkspaceApiError("Learning status is unavailable", undefined,
        "learning_status_unavailable", "retry_read");
    return this.session.track(view.learningStatus, request);
  }

  sessionView(agentId: string, sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${sessionPath(agentId, sessionId)}/view`, { signal });
  }

  turns(agentId: string, sessionId: string, cursor?: string, signal?: AbortSignal): Promise<unknown> {
    const query = cursor === undefined ? "" : `?${new URLSearchParams({ cursor })}`;
    return this.request(`${sessionPath(agentId, sessionId)}/turns${query}`, { signal });
  }

  turnContent(agentId: string, sessionId: string, turnId: string, cursor: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${sessionPath(agentId, sessionId)}/turns/${segment(turnId)}/content?${new URLSearchParams({ cursor })}`, { signal });
  }

  process(agentId: string, sessionId: string, turnId: string, cursor?: string, signal?: AbortSignal): Promise<unknown> {
    const query = cursor === undefined ? "" : `?${new URLSearchParams({ cursor })}`;
    return this.request(`${sessionPath(agentId, sessionId)}/turns/${segment(turnId)}/process${query}`, { signal });
  }

  processContent(agentId: string, sessionId: string, turnId: string, itemId: string, cursor: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${sessionPath(agentId, sessionId)}/turns/${segment(turnId)}/process/${segment(itemId)}/content?${new URLSearchParams({ cursor })}`, { signal });
  }

  sessions(agentId: string, cursor?: string, signal?: AbortSignal): Promise<unknown> {
    const query = cursor === undefined ? "" : `?${new URLSearchParams({ cursor })}`;
    return this.request(`${agentPath(agentId)}/sessions${query}`, { signal });
  }

  createSession(agentId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${agentPath(agentId)}/sessions`, { method: "POST", body: {}, signal });
  }

  async control(agentId: string, input: ControlRequest, signal?: AbortSignal): Promise<ControlResult> {
    const raw = await this.request(`${agentPath(agentId)}/commands`, { method: "POST", body: input, signal });
    const request = this.captureSession();
    const result = controlResultSchema.safeParse(raw);
    if (!result.success) throw new WorkspaceApiError("Command result could not be verified. Refresh before retrying.",
      503, "invalid_command_result", "refresh");
    return this.session.track(result.data, request);
  }

  prompt(agentId: string, sessionId: string, admission: PromptAdmission, signal?: AbortSignal, action?: "retry"): Promise<PromptAccepted> {
    return this.request(`${sessionPath(agentId, sessionId)}/prompts${action === "retry" ? "?action=retry" : ""}`, {
      method: "POST",
      body: {
        intentId: admission.intentId,
        expectedAppendVersion: admission.expectedAppendVersion,
        prompt: admission.prompt,
      },
      headers: {
        "If-Match": admission.historyToken,
        "Idempotency-Key": admission.intentId,
      },
      signal,
      ambiguousOperationId: admission.intentId,
    }) as Promise<PromptAccepted>;
  }

  operation(agentId: string, sessionId: string, intentId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${sessionPath(agentId, sessionId)}/operations/${segment(intentId)}`, { signal });
  }

  cancel(agentId: string, sessionId: string, intentId: string, expectedRunId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${sessionPath(agentId, sessionId)}/operations/${segment(intentId)}/cancel`, {
      method: "POST", body: { expectedRunId }, signal,
    });
  }

  configuration(agentId: string, sessionId: string, configId: string, value: string | boolean, expectedConfigurationToken: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${sessionPath(agentId, sessionId)}/configuration`, {
      method: "POST", body: { configId, value, expectedConfigurationToken }, signal,
    });
  }

  decidePermission(agentId: string, permissionId: string, generation: number, optionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`${agentPath(agentId)}/permissions/${segment(permissionId)}/decision`, {
      method: "POST", body: { generation, optionId }, signal,
    });
  }

  eventsURL(agentId: string, sessionId: string | null, cursor?: string): string {
    this.captureSession();
    const query = new URLSearchParams();
    if (sessionId !== null) query.set("sessionId", sessionId);
    if (cursor !== undefined) query.set("cursor", cursor);
    const suffix = query.size === 0 ? "" : `?${query}`;
    return `${agentPath(agentId)}/events${suffix}`;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const requestSession = this.captureSession();
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (method === "POST") {
      headers.set("X-Antnest-CSRF-Token", requestSession.hint!);
      headers.set("Content-Type", "application/json");
    }
    const controller = new AbortController();
    const detachSession = this.session.onCancel(requestSession, () => controller.abort(new BrowserSessionChanged()));
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Workspace request timed out"));
    }, this.timeoutMs);
    let rejectAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    let responseStatus: number | undefined;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await Promise.race([interrupted, (async () => {
        const response = await this.fetcher(path, {
          method, credentials: "same-origin", cache: "no-store", headers,
          ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });
        this.captureSession();
        controller.signal.throwIfAborted();
        responseStatus = response.status;
        const result: unknown = await response.json();
        this.captureSession();
        controller.signal.throwIfAborted();
        if (response.ok) return this.session.track(result, requestSession);
        const error = isRecord(result) ? result : {};
        throw new WorkspaceApiError(
          typeof error.message === "string" ? error.message : "Workspace request failed",
          response.status,
          typeof error.code === "string" ? error.code : "workspace_request_failed",
          options.ambiguousOperationId && response.status >= 500
            ? "query_operation"
            : isRecovery(error.recovery) ? error.recovery : "retry_read",
          options.ambiguousOperationId,
        );
      })()]);
      this.captureSession();
      controller.signal.throwIfAborted();
      return result;
    } catch (cause) {
      if (!this.session.current(requestSession) || cause instanceof BrowserSessionChanged) throw changedSession();
      if (responseStatus === 401) {
        detachSession();
        this.session.end(requestSession);
        throw new WorkspaceApiError("Your browser session ended. Sign in again.", 401, "unauthorized", "login");
      }
      if (cause instanceof WorkspaceApiError) throw cause;
      throw new WorkspaceApiError(
        timedOut ? "Workspace request timed out" :
          controller.signal.aborted ? "Workspace request was interrupted" :
            "Workspace connection failed",
        undefined,
        timedOut ? "workspace_request_timeout" :
          controller.signal.aborted ? "workspace_request_interrupted" :
            "workspace_network_error",
        options.ambiguousOperationId ? "query_operation" : "retry_read",
        options.ambiguousOperationId,
      );
    } finally {
      detachSession();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
}

function changedSession(): WorkspaceApiError {
  return new WorkspaceApiError("The browser session changed. Validate the current session before trying again.",
    undefined, "browser_session_changed", "none");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecovery(value: unknown): value is WorkspaceRecovery {
  return value === "refresh" || value === "query_operation" || value === "login" ||
    value === "retry_read" || value === "none";
}
