import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { z } from "zod";
import type { BridgeScope } from "../bridge/registry.ts";
import { ConfigurationConflictError } from "../bridge/configuration-token.ts";
import { withActiveHttpTrace } from "../telemetry.ts";

const BRIDGE_CAPABILITY = "antnest.dev/bridge";
const DELIVERY = "antnest.dev/delivery";
const INTENT = "antnest.dev/intent";
const TARGET_CANCEL = "antnest.dev/target-cancel";
const CONFIGURATION = "antnest.dev/configuration";

type PromptInput = {
  sessionId: string;
  prompt: acp.ContentBlock[];
  intentId: string;
  expectedAppendVersion: number;
};

function promptParams(input: PromptInput): acp.PromptRequest {
  return {
    sessionId: input.sessionId,
    prompt: input.prompt,
    _meta: {
      [INTENT]: {
        intentId: input.intentId,
        expectedAppendVersion: input.expectedAppendVersion,
      },
    },
  };
}

export function acpPromptRequestBytes(input: PromptInput): number {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: Number.MAX_SAFE_INTEGER,
      method: "session/prompt",
      params: promptParams(input),
    }),
  );
}

export function configurationParams(
  sessionId: string,
  configId: string,
  value: string | boolean,
  expectedRevision: string,
): acp.SetSessionConfigOptionRequest {
  if (!/^[a-f0-9]{64}$/u.test(expectedRevision))
    throw new BridgeCapabilityError("Invalid producer configuration revision");
  const _meta = { [CONFIGURATION]: { expectedRevision } };
  return typeof value === "boolean"
    ? { sessionId, configId, type: "boolean", value, _meta }
    : { sessionId, configId, value, _meta };
}

const receiptSchema = z.strictObject({
  intentId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  phase: z.enum([
    "persisting",
    "accepted",
    "running",
    "awaiting_permission",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ]),
  appendVersion: z.number().int().nonnegative().safe(),
  outputWatermark: z.number().int().nonnegative().safe(),
  stopReason: z.string().nullable(),
  errorClass: z.string().max(128).nullable(),
});

const observationSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  appendVersion: z.number().int().nonnegative().safe(),
  outputWatermark: z.number().int().nonnegative().safe(),
  activeRunId: z.string().min(1).max(200).nullable(),
  recentReceipts: z.array(receiptSchema),
  configurationRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});

const agentStateBase = {
  agent_id: z.string().min(1).max(200),
  access_allowed: z.literal(true),
  configuration_revision: z.string().regex(/^[a-f0-9]{64}$/u),
};
const agentStateSchema = z.union([
  z.strictObject({
    ...agentStateBase,
    availability: z.literal("ready"),
    active_session_id: z.null(),
    unavailable_reason: z.null(),
  }),
  z.strictObject({
    ...agentStateBase,
    availability: z.literal("busy"),
    active_session_id: z.string().min(1).max(200).nullable(),
    unavailable_reason: z.literal("agent_unavailable").nullable(),
  }),
  z.strictObject({
    ...agentStateBase,
    availability: z.literal("offline"),
    active_session_id: z.null(),
    unavailable_reason: z.enum([
      "agent_unavailable",
      "runtime_barrier_required",
    ]),
  }),
]);

export type IntentReceipt = z.infer<typeof receiptSchema>;
export type ExecutionObservation = z.infer<typeof observationSchema>;
export type AgentExecutionState = {
  availability: "ready" | "busy" | "offline";
  activeSessionId: string | null;
};

export class BridgeCapabilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BridgeCapabilityError";
  }
}

export class AgentAccessRevokedError extends BridgeCapabilityError {
  public constructor() {
    super("ACP Agent access was revoked");
    this.name = "AgentAccessRevokedError";
  }
}

export class SessionNotFoundError extends BridgeCapabilityError {
  public constructor() {
    super("ACP Session was not found");
    this.name = "SessionNotFoundError";
  }
}

export function sessionRequestFailure(cause: unknown): SessionNotFoundError | undefined {
  if (!(cause instanceof acp.RequestError) || cause.data === null ||
    typeof cause.data !== "object" || Array.isArray(cause.data)) return undefined;
  return (cause.data as Record<string, unknown>).code === "session_not_found"
    ? new SessionNotFoundError() : undefined;
}

export function bridgeHeaders(scope: BridgeScope): Record<string, string> {
  for (const value of [
    scope.organizationId,
    scope.principalId,
    scope.agentId,
  ]) {
    if (
      value.length === 0 ||
      value.length > 200 ||
      value.trim() !== value ||
      value.includes(",") ||
      value.includes("\t") ||
      /[\r\n]/u.test(value)
    )
      throw new BridgeCapabilityError("Invalid trusted Bridge scope");
  }
  return {
    "x-antnest-organization-id": scope.organizationId,
    "x-antnest-principal-id": scope.principalId,
    "x-antnest-agent-id": scope.agentId,
  };
}

export function requireBridgeCapabilities(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  const value = meta?.[BRIDGE_CAPABILITY];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new BridgeCapabilityError("ACP Bridge capability is unavailable");
  const capabilities = value as Record<string, unknown>;
  if (
    capabilities.intentReceipt !== 1 ||
    capabilities.targetCancel !== 1 ||
    capabilities.deliveryMark !== 1
  )
    throw new BridgeCapabilityError("ACP Bridge capability is incomplete");
  return capabilities.configurationCas === 1;
}

export function requireLoadCut(
  meta: Record<string, unknown> | null | undefined,
): {
  sealedWatermark: number;
  appendVersion: number;
} {
  const value = meta?.[DELIVERY];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new BridgeCapabilityError("ACP load omitted its delivery cut");
  const cut = value as Record<string, unknown>;
  if (!revision(cut.sealedWatermark) || !revision(cut.appendVersion))
    throw new BridgeCapabilityError(
      "ACP load returned an invalid delivery cut",
    );
  return {
    sealedWatermark: cut.sealedWatermark,
    appendVersion: cut.appendVersion,
  };
}

export type AcpBridgeCallbacks = {
  update(params: acp.SessionNotification): void | Promise<void>;
  requestPermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>;
};

export class AcpHttpBridge {
  public readonly capabilities: acp.AgentCapabilities;
  private readonly connection: acp.ClientConnection;
  private readonly baseUrl: URL;
  private readonly scope: BridgeScope;
  private readonly fetchImpl: typeof fetch;
  private readonly configurationCas: boolean;

  private constructor(
    connection: acp.ClientConnection,
    baseUrl: URL,
    scope: BridgeScope,
    fetchImpl: typeof fetch,
    capabilities: acp.AgentCapabilities,
    configurationCas: boolean,
  ) {
    this.connection = connection;
    this.baseUrl = baseUrl;
    this.scope = scope;
    this.fetchImpl = fetchImpl;
    this.capabilities = capabilities;
    this.configurationCas = configurationCas;
  }

  public static async open(input: {
    baseUrl: URL;
    scope: BridgeScope;
    callbacks: AcpBridgeCallbacks;
    fetchImpl?: typeof fetch;
  }): Promise<AcpHttpBridge> {
    const headers = bridgeHeaders(input.scope);
    const tracedFetch = withActiveHttpTrace(input.fetchImpl ?? fetch);
    const application = acp
      .client({ name: "antnest-agent-ui-bridge" })
      .onNotification(acp.methods.client.session.update, ({ params }) =>
        input.callbacks.update(params),
      )
      .onRequest(
        acp.methods.client.session.requestPermission,
        ({ params, signal }) =>
          input.callbacks.requestPermission(params, signal),
      );
    const connection = application.connect(
      createHttpStream(new URL("/v1/acp", input.baseUrl).toString(), {
        headers,
        cookies: "omit",
        fetch: tracedFetch,
      }),
    );
    try {
      const initialized = await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "antnest-agent-ui-bridge", version: "0.1.0" },
          _meta: {
            [BRIDGE_CAPABILITY]: {
              intentReceipt: 1,
              targetCancel: 1,
              deliveryMark: 1,
              configurationCas: 1,
            },
          },
        },
      );
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION)
        throw new BridgeCapabilityError("ACP protocol version is unsupported");
      const configurationCas = requireBridgeCapabilities(initialized._meta);
      const capabilities = initialized.agentCapabilities;
      if (capabilities?.loadSession !== true)
        throw new BridgeCapabilityError(
          "ACP Session load is required by Bridge",
        );
      return new AcpHttpBridge(
        connection,
        input.baseUrl,
        input.scope,
        tracedFetch,
        capabilities,
        configurationCas,
      );
    } catch (error) {
      connection.close(error);
      throw error;
    }
  }

  public get closed(): Promise<unknown> {
    return this.connection.closed;
  }

  public async load(sessionId: string): Promise<{
    response: acp.LoadSessionResponse;
    cut: { sealedWatermark: number; appendVersion: number };
  }> {
    let response: acp.LoadSessionResponse;
    try {
      response = await this.connection.agent.request(
        acp.methods.agent.session.load,
        {
          sessionId,
          cwd: "/workspace",
          mcpServers: [],
        },
      );
    } catch (cause) {
      throw sessionRequestFailure(cause) ?? cause;
    }
    return { response, cut: requireLoadCut(response._meta) };
  }

  public list(cursor?: string): Promise<acp.ListSessionsResponse> {
    return this.connection.agent.request(
      acp.methods.agent.session.list,
      cursor === undefined ? {} : { cursor },
    );
  }

  public createSession(): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
  }

  public forkSession(sessionId: string): Promise<acp.ForkSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.fork, {
      sessionId, cwd: "/workspace", mcpServers: [],
    });
  }

  public prompt(input: PromptInput): Promise<acp.PromptResponse> {
    return this.connection.agent.request(
      acp.methods.agent.session.prompt,
      promptParams(input),
    );
  }

  public cancel(sessionId: string, expectedRunId: string): Promise<void> {
    return this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
      _meta: { [TARGET_CANCEL]: { expectedRunId } },
    });
  }

  public async setConfiguration(
    sessionId: string,
    configId: string,
    value: string | boolean,
    expectedRevision: string,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (!this.configurationCas)
      throw new BridgeCapabilityError(
        "ACP conditional configuration is unavailable",
      );
    try {
      return await this.connection.agent.request(
        acp.methods.agent.session.setConfigOption,
        configurationParams(sessionId, configId, value, expectedRevision),
      );
    } catch (cause) {
      const missing = sessionRequestFailure(cause);
      if (missing !== undefined) throw missing;
      if (
        cause instanceof acp.RequestError &&
        cause.data !== null &&
        typeof cause.data === "object" &&
        !Array.isArray(cause.data) &&
        (cause.data as Record<string, unknown>).code ===
          "configuration_conflict"
      )
        throw new ConfigurationConflictError(
          "Producer configuration revision changed",
        );
      throw cause;
    }
  }

  public async readIntent(
    sessionId: string,
    intentId: string,
    signal?: AbortSignal,
  ): Promise<
    { kind: "receipt"; receipt: IntentReceipt } | { kind: "unknown" }
  > {
    const response = await this.internalGet(
      `/rpc/agent-acp/workspace/sessions/${encodeURIComponent(sessionId)}/intents/${encodeURIComponent(intentId)}`,
      signal,
    );
    return parseIntentObservation(response);
  }

  public async readExecution(sessionId: string): Promise<ExecutionObservation> {
    const response = await this.internalGet(
      `/rpc/agent-acp/workspace/sessions/${encodeURIComponent(sessionId)}/execution`,
    );
    await requireSuccessfulObservation(response);
    return observationSchema.parse(await response.json());
  }

  public async readAgentExecutionState(): Promise<AgentExecutionState> {
    const response = await this.fetchImpl(
      new URL("/rpc/agent-acp/get-agent-execution-state", this.baseUrl),
      {
        method: "POST",
        headers: {
          ...bridgeHeaders(this.scope),
          accept: "application/json",
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      },
    );
    return parseAgentExecutionState(response, this.scope.agentId);
  }

  public async watchAgentExecutionState(
    changed: (state: AgentExecutionState) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(
      new URL("/rpc/agent-acp/watch-agent-execution-state", this.baseUrl),
      {
        method: "POST",
        headers: {
          ...bridgeHeaders(this.scope),
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: "{}",
        signal,
        redirect: "error",
        cache: "no-store",
      },
    );
    await consumeAgentExecutionStateStream(
      response,
      this.scope.agentId,
      changed,
      signal,
    );
  }

  public close(): void {
    this.connection.close();
  }

  private internalGet(path: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(new URL(path, this.baseUrl), {
      method: "GET",
      headers: { ...bridgeHeaders(this.scope), accept: "application/json" },
      signal:
        signal === undefined
          ? AbortSignal.timeout(10_000)
          : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
  }
}

export async function parseAgentExecutionState(
  response: Response,
  agentId: string,
): Promise<AgentExecutionState> {
  await requireSuccessfulObservation(response);
  return parseAuthorizedAgentState(await response.json(), agentId);
}

function parseAuthorizedAgentState(
  input: unknown,
  agentId: string,
): AgentExecutionState {
  if (
    input !== null &&
    typeof input === "object" &&
    (input as Record<string, unknown>).agent_id === agentId &&
    (input as Record<string, unknown>).access_allowed === false
  )
    throw new AgentAccessRevokedError();
  const state = agentStateSchema.safeParse(input);
  if (!state.success || state.data.agent_id !== agentId)
    throw new BridgeCapabilityError("ACP Agent execution scope is unavailable");
  return {
    availability: state.data.availability,
    activeSessionId: state.data.active_session_id,
  };
}

export async function consumeAgentExecutionStateStream(
  response: Response,
  agentId: string,
  changed: (state: AgentExecutionState) => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (response.status === 403) throw new AgentAccessRevokedError();
  await requireSuccessfulObservation(response);
  if (
    !response.headers.get("content-type")?.startsWith("text/event-stream") ||
    response.body === null
  )
    throw new BridgeCapabilityError("ACP Agent state watch is not SSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        if (end > 65_536)
          throw new BridgeCapabilityError("ACP Agent state frame is too large");
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = frame.split("\n");
        const event = lines
          .find((line) => line.startsWith("event: "))
          ?.slice(7);
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (event === "workspace_error")
          throw new BridgeCapabilityError("ACP Agent state watch failed");
        if (event === "workspace_state") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new BridgeCapabilityError("ACP Agent state frame is invalid");
          }
          await changed(parseAuthorizedAgentState(parsed, agentId));
        }
        end = buffer.indexOf("\n\n");
      }
      if (buffer.length > 65_536)
        throw new BridgeCapabilityError("ACP Agent state frame is too large");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}

export async function parseIntentObservation(
  response: Response,
): Promise<{ kind: "receipt"; receipt: IntentReceipt } | { kind: "unknown" }> {
  if (response.status === 404) {
    const body: unknown = await response.json().catch(() => null);
    if (
      body !== null &&
      typeof body === "object" &&
      (body as Record<string, unknown>).code === "intent_unknown"
    )
      return { kind: "unknown" };
    if (body !== null && typeof body === "object" &&
      (body as Record<string, unknown>).code === "session_not_found")
      throw new SessionNotFoundError();
    throw new BridgeCapabilityError("ACP workspace access is unavailable");
  }
  await requireSuccessfulObservation(response);
  return {
    kind: "receipt",
    receipt: receiptSchema.parse(await response.json()),
  };
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function requireSuccessfulObservation(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 404) {
    const body: unknown = await response.json().catch(() => null);
    if (body !== null && typeof body === "object" &&
      (body as Record<string, unknown>).code === "session_not_found")
      throw new SessionNotFoundError();
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  )
    throw new BridgeCapabilityError("ACP workspace access is unavailable");
  throw new Error(`ACP observation failed with HTTP ${response.status}`);
}
