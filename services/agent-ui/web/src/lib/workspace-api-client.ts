import type { ContentBlock } from "@agentclientprotocol/sdk";

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
  csrf: () => string | undefined;
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
  private readonly csrf: Options["csrf"];
  private readonly timeoutMs: number;

  constructor(options: Options) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.csrf = options.csrf;
    this.timeoutMs = options.timeoutMs ?? ordinaryTimeoutMs;
  }

  bootstrap(signal?: AbortSignal): Promise<unknown> {
    return this.request(`${base}/bootstrap`, { signal });
  }

  agentView(agentId: string, sessionId: string | null = null, signal?: AbortSignal): Promise<unknown> {
    const query = sessionId === null ? "" : `?${new URLSearchParams({ sessionId })}`;
    return this.request(`${agentPath(agentId)}/view${query}`, { signal });
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

  prompt(agentId: string, sessionId: string, admission: PromptAdmission, signal?: AbortSignal): Promise<PromptAccepted> {
    return this.request(`${sessionPath(agentId, sessionId)}/prompts`, {
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
    const query = new URLSearchParams();
    if (sessionId !== null) query.set("sessionId", sessionId);
    if (cursor !== undefined) query.set("cursor", cursor);
    const suffix = query.size === 0 ? "" : `?${query}`;
    return `${agentPath(agentId)}/events${suffix}`;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (method === "POST") {
      const csrf = this.csrf();
      if (!csrf) throw new WorkspaceApiError("Request could not be verified", undefined, "csrf_missing", "refresh");
      headers.set("X-Antnest-CSRF-Token", csrf);
      headers.set("Content-Type", "application/json");
    }
    const controller = new AbortController();
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
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      return await Promise.race([interrupted, (async () => {
        const response = await this.fetcher(path, {
          method, credentials: "same-origin", headers,
          ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });
        const result: unknown = await response.json();
        if (response.ok) return result;
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
    } catch (cause) {
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
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecovery(value: unknown): value is WorkspaceRecovery {
  return value === "refresh" || value === "query_operation" || value === "login" ||
    value === "retry_read" || value === "none";
}
