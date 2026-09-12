import { tracedFetch } from "../../telemetry/http.js";
import { z } from "zod";
import { catalogSchema, configurationSchema, encodeConfiguration } from "./configuration.js";
import { modelPricingSchema } from "../../domain/usage.js";

import type {
  AcquireRunInput,
  AcquireRunResult,
  AgentControllerPort,
  FinishRunInput,
  ResolveAgentAccessInput,
  ResolveAgentAccessResult,
  ResolveCredentialInput,
  ResolveCredentialResult,
} from "../../ports/agent-controller.js";
import {
  AGENT_CONTROLLER_ERROR_CODES,
  AgentControllerError,
  type AgentControllerErrorCode,
} from "../../ports/agent-controller.js";

export { AgentControllerError } from "../../ports/agent-controller.js";

type FetchFn = (input: URL, init: RequestInit) => Promise<Response>;

const maximumResponseBytes = 1_048_576;

const pricingSchema = z
  .object({
    currency: modelPricingSchema.shape.currency,
    input_per_million: modelPricingSchema.shape.inputPerMillion,
    output_per_million: modelPricingSchema.shape.outputPerMillion,
    cache_read_per_million: modelPricingSchema.shape.cacheReadPerMillion,
    cache_write_per_million: modelPricingSchema.shape.cacheWritePerMillion,
  })
  .strict()
  .transform((price) => ({
    currency: price.currency,
    inputPerMillion: price.input_per_million,
    outputPerMillion: price.output_per_million,
    ...(price.cache_read_per_million === undefined
      ? {}
      : { cacheReadPerMillion: price.cache_read_per_million }),
    ...(price.cache_write_per_million === undefined
      ? {}
      : { cacheWritePerMillion: price.cache_write_per_million }),
  }));

export type AgentControllerClientOptions = {
  baseUrl: URL;
  fetchFn?: FetchFn;
  timeoutMs: number;
};

export type AgentControllerStatusOptions = {
  serviceUrl: URL;
  fetchFn?: FetchFn;
  timeoutMs: number;
};

const errorSchema = z
  .object({
    code: z.enum(AGENT_CONTROLLER_ERROR_CODES),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

const errorContract: Record<
  AgentControllerErrorCode,
  { readonly status: number; readonly retryable: boolean }
> = {
  access_denied: { status: 403, retryable: false },
  agent_not_found: { status: 404, retryable: false },
  agent_busy: { status: 409, retryable: true },
  agent_rebuilding: { status: 409, retryable: true },
  agent_build_failed: { status: 409, retryable: false },
  agent_not_ready: { status: 409, retryable: true },
  admission_not_found: { status: 404, retryable: false },
  credential_not_allowed: { status: 403, retryable: false },
  invalid_request: { status: 400, retryable: false },
  dependency_unavailable: { status: 503, retryable: true },
  internal_error: { status: 500, retryable: true },
  model_unavailable: { status: 409, retryable: false },
  configuration_conflict: { status: 409, retryable: false },
};

const statusSchema = z.object({ status: z.literal("ready") }).strict();

const accessSchema = z
  .object({
    principal_id: z.string().min(1),
    agent_id: z.string().min(1),
    access_revision: z.string().min(1),
    prompt_capabilities: z
      .object({
        image: z.boolean(),
        embedded_context: z.boolean(),
        audio: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const acquireSchema = z
  .object({
    admission_id: z.string().min(1),
    admission_deadline: z.iso.datetime(),
    agent_spec_revision: z.string().min(1),
    execution_revision: z.string().min(1),
    runtime_mcp_source_digest: z.string().regex(/^[a-f0-9]{64}$/u),
    agent_execution_spec_digest: z.string().regex(/^[a-f0-9]{64}$/u),
    credential_version: z.string().min(1),
    runtime: z
      .object({
        runtime_revision: z.string().min(1),
        runtime_execution_id: z.string().min(1),
        mcp_endpoint: z.url(),
      })
      .strict(),
    execution_spec: z
      .object({
        configuration: configurationSchema.optional(),
        system_prompt: z.string(),
        context_policy_version: z.literal("context-v1"),
        skill_instructions: z.array(
          z
            .object({
              skill_key: z.string().min(1),
              version: z.string().min(1),
              instructions: z.string(),
            })
            .strict(),
        ),
        model: z
          .object({
            base_url: z.url(),
            model: z.string().min(1),
            context_window: z.number().int().min(1024),
            max_output_tokens: z.number().int().positive(),
            temperature: z.number().min(0).max(2).optional(),
            supports_images: z.boolean(),
            supports_audio: z.boolean().optional(),
            supports_pdf: z.boolean().optional(),
            pricing: pricingSchema.optional(),
          })
          .strict(),
        max_model_requests: z.number().int().min(1).max(128),
        credential_ref: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const credentialSchema = z
  .object({
    credential_version: z.string().min(1),
    secret_type: z.literal("bearer"),
    secret: z.string().min(1),
  })
  .strict();

const finishSchema = z
  .object({
    status: z.enum(["finished", "already_finished"]),
    admission_state: z.enum(["released", "blocked_unknown_effect"]),
  })
  .strict();

export async function requireAgentControllerReady(
  options: AgentControllerStatusOptions,
  signal?: AbortSignal,
): Promise<void> {
  const fetchFn = tracedFetch(
    options.fetchFn ?? ((input: URL, init: RequestInit) => fetch(input, init)),
    "agent-controller",
  );
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetchFn(new URL("status", options.serviceUrl), {
      method: "GET",
      headers: propagatedHeaders(false),
      redirect: "error",
      signal: requestSignal,
    });
  } catch (error) {
    throw dependencyUnavailable("Agent Controller status request failed", error);
  }
  if (response.status !== 200 || !isJSON(response)) {
    throw dependencyUnavailable("Agent Controller status is not ready");
  }
  const parsed = statusSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw dependencyUnavailable("Agent Controller returned an invalid status", parsed.error);
  }
}

export class AgentControllerClient implements AgentControllerPort {
  private readonly fetchFn: FetchFn;

  public constructor(private readonly options: AgentControllerClientOptions) {
    this.fetchFn = tracedFetch(
      options.fetchFn ?? ((input: URL, init: RequestInit) => fetch(input, init)),
      "agent-controller",
    );
  }

  public getSessionConfiguration(
    input: Parameters<AgentControllerPort["getSessionConfiguration"]>[0],
    signal?: AbortSignal,
  ) {
    return this.post(
      "get-session-configuration",
      {
        request_id: input.requestId,
        agent_id: input.agentId,
        principal_id: input.principalId,
        expected_access_revision: input.expectedAccessRevision,
        ...(input.afterId === undefined ? {} : { after_id: input.afterId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      catalogSchema,
      signal,
    );
  }

  public async resolveAgentAccess(
    input: ResolveAgentAccessInput,
    signal?: AbortSignal,
  ): Promise<ResolveAgentAccessResult> {
    const result = await this.post(
      "resolve-agent-access",
      {
        request_id: input.requestId,
        agent_access_subject: input.agentAccessSubject,
      },
      accessSchema,
      signal,
    );
    return {
      principalId: result.principal_id,
      agentId: result.agent_id,
      accessRevision: result.access_revision,
      promptCapabilities: {
        image: result.prompt_capabilities.image,
        embeddedContext: result.prompt_capabilities.embedded_context,
        ...(result.prompt_capabilities.audio === undefined
          ? {}
          : { audio: result.prompt_capabilities.audio }),
      },
    };
  }

  public async acquireRun(input: AcquireRunInput, signal?: AbortSignal): Promise<AcquireRunResult> {
    const result = await this.post(
      "acquire-run",
      {
        request_id: input.requestId,
        agent_id: input.agentId,
        principal_id: input.principalId,
        expected_access_revision: input.expectedAccessRevision,
        session_id: input.sessionId,
        ...(input.sessionConfiguration === undefined
          ? {}
          : { session_configuration: encodeConfiguration(input.sessionConfiguration) }),
      },
      acquireSchema,
      signal,
    );
    if (
      input.sessionConfiguration !== undefined &&
      result.execution_spec.configuration === undefined
    )
      throw dependencyUnavailable("Controller omitted the admitted Session configuration");
    return {
      admissionId: result.admission_id,
      admissionDeadline: new Date(result.admission_deadline),
      agentSpecRevision: result.agent_spec_revision,
      executionRevision: result.execution_revision,
      runtimeMcpSourceDigest: result.runtime_mcp_source_digest,
      agentExecutionSpecDigest: result.agent_execution_spec_digest,
      credentialVersion: result.credential_version,
      runtime: {
        revision: result.runtime.runtime_revision,
        executionId: result.runtime.runtime_execution_id,
        mcpEndpoint: result.runtime.mcp_endpoint,
      },
      executionSpec: {
        ...(result.execution_spec.configuration === undefined
          ? {}
          : { configuration: result.execution_spec.configuration }),
        systemPrompt: result.execution_spec.system_prompt,
        contextPolicyVersion: result.execution_spec.context_policy_version,
        skillInstructions: result.execution_spec.skill_instructions.map((skill) => ({
          skillKey: skill.skill_key,
          version: skill.version,
          instructions: skill.instructions,
        })),
        model: {
          baseUrl: result.execution_spec.model.base_url,
          model: result.execution_spec.model.model,
          contextWindow: result.execution_spec.model.context_window,
          maxOutputTokens: result.execution_spec.model.max_output_tokens,
          ...(result.execution_spec.model.temperature === undefined
            ? {}
            : { temperature: result.execution_spec.model.temperature }),
          supportsImages: result.execution_spec.model.supports_images,
          ...(result.execution_spec.model.supports_audio === undefined
            ? {}
            : { supportsAudio: result.execution_spec.model.supports_audio }),
          ...(result.execution_spec.model.supports_pdf === undefined
            ? {}
            : { supportsPdf: result.execution_spec.model.supports_pdf }),
          ...(result.execution_spec.model.pricing === undefined
            ? {}
            : { pricing: result.execution_spec.model.pricing }),
        },
        maxModelRequests: result.execution_spec.max_model_requests,
        credentialRef: result.execution_spec.credential_ref,
      },
    };
  }

  public async resolveCredential(
    input: ResolveCredentialInput,
    signal?: AbortSignal,
  ): Promise<ResolveCredentialResult> {
    const result = await this.post(
      "resolve-credential",
      {
        request_id: input.requestId,
        admission_id: input.admissionId,
        credential_ref: input.credentialRef,
      },
      credentialSchema,
      signal,
    );
    return {
      credentialVersion: result.credential_version,
      secretType: result.secret_type,
      secret: result.secret,
    };
  }

  public async finishRun(input: FinishRunInput, signal?: AbortSignal): Promise<void> {
    await this.post(
      "finish-run",
      {
        request_id: input.requestId,
        admission_id: input.admissionId,
        terminal_class: input.terminalClass,
        tool_effect_state: input.toolEffectState,
        unknown_effect_source: input.unknownEffectSource ?? null,
        stop_reason: input.stopReason ?? null,
        error_class: input.errorClass ?? null,
      },
      finishSchema,
      signal,
    );
  }

  private async post<Output>(
    path: string,
    body: unknown,
    schema: z.ZodType<Output>,
    signal?: AbortSignal,
  ): Promise<Output> {
    const headers = propagatedHeaders(true);
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchFn(new URL(path, this.options.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal,
      });
    } catch (error) {
      throw new AgentControllerError(
        "dependency_unavailable",
        "Agent Controller request did not produce a trusted response",
        true,
        { cause: error },
      );
    }
    if (!isJSON(response)) {
      throw dependencyUnavailable("Agent Controller returned a non-JSON response");
    }
    const payload = await readJson(response);
    if (response.status !== 200) {
      const parsed = errorSchema.safeParse(payload);
      if (
        parsed.success &&
        errorContract[parsed.data.code].status === response.status &&
        errorContract[parsed.data.code].retryable === parsed.data.retryable
      ) {
        throw new AgentControllerError(
          parsed.data.code,
          parsed.data.message,
          parsed.data.retryable,
        );
      }
      throw dependencyUnavailable(`Agent Controller returned invalid HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new AgentControllerError(
        "dependency_unavailable",
        "Agent Controller returned an invalid response",
        true,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > maximumResponseBytes) {
      throw new Error("response exceeds the maximum size");
    }
    if (response.body === null) {
      throw new Error("response has no body");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let read = await reader.read();
    while (!read.done) {
      const { value } = read;
      length += value.byteLength;
      if (length > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response exceeds the maximum size");
      }
      chunks.push(value);
      read = await reader.read();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch (error) {
    throw dependencyUnavailable("Agent Controller returned a non-JSON response", error);
  }
}

function propagatedHeaders(withBody: boolean): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (withBody) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

function isJSON(response: Response): boolean {
  return (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function dependencyUnavailable(message: string, cause?: unknown): AgentControllerError {
  return new AgentControllerError(
    "dependency_unavailable",
    message,
    true,
    cause === undefined ? undefined : { cause },
  );
}
