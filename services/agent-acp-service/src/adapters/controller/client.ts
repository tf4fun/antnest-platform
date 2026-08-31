import { context, propagation } from "@opentelemetry/api";
import { z } from "zod";

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
} from "../../ports/agent-controller.js";

export { AgentControllerError } from "../../ports/agent-controller.js";

type FetchFn = (input: URL, init: RequestInit) => Promise<Response>;

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

const errorSchema = z.object({
  code: z.enum(AGENT_CONTROLLER_ERROR_CODES),
  message: z.string().min(1),
  retryable: z.boolean(),
});

const statusSchema = z.object({ status: z.literal("ready") });

const accessSchema = z.object({
  principal_id: z.string().min(1),
  agent_id: z.string().min(1),
  access_revision: z.string().min(1),
  prompt_capabilities: z
    .object({
      image: z.boolean().default(false),
      embedded_context: z.boolean().default(false),
    })
    .default({ image: false, embedded_context: false }),
});

const acquireSchema = z.object({
  admission_id: z.string().min(1),
  admission_deadline: z.iso.datetime(),
  agent_config_revision: z.string().min(1),
  execution_revision: z.string().min(1),
  runtime_mcp_source_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  agent_execution_spec_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  credential_version: z.string().min(1),
  runtime: z.object({
    runtime_generation: z.number().int().positive(),
    runtime_instance_id: z.string().min(1),
    runtime_execution_id: z.string().min(1),
    mcp_endpoint: z.url(),
  }),
  execution_spec: z.object({
    system_prompt: z.string(),
    skill_instructions: z
      .array(
        z.object({
          skill_key: z.string().min(1),
          version: z.string().min(1),
          instructions: z.string(),
        }),
      )
      .default([]),
    model: z.object({
      adapter: z.literal("openai_compatible"),
      base_url: z.url(),
      model: z.string().min(1),
      context_window: z.number().int().min(1024),
      max_output_tokens: z.number().int().positive(),
      temperature: z.number().min(0).max(2).optional(),
      supports_images: z.boolean().default(false),
    }),
    max_model_requests: z.number().int().min(1).max(128),
    credential_ref: z.string().min(1),
  }),
});

const credentialSchema = z.object({
  credential_version: z.string().min(1),
  secret_type: z.literal("bearer"),
  secret: z.string().min(1),
});

const finishSchema = z.object({ status: z.enum(["finished", "already_finished"]) });

export async function requireAgentControllerReady(
  options: AgentControllerStatusOptions,
  signal?: AbortSignal,
): Promise<void> {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetchFn(new URL("status", options.serviceUrl), {
      method: "GET",
      headers: propagatedHeaders(false),
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
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  public async resolveAgentAccess(
    input: ResolveAgentAccessInput,
    signal?: AbortSignal,
  ): Promise<ResolveAgentAccessResult> {
    const result = await this.post(
      "resolve-agent-access",
      {
        request_id: input.requestId,
        authenticated_subject: input.authenticatedSubject,
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
      },
    };
  }

  public async acquireRun(input: AcquireRunInput, signal?: AbortSignal): Promise<AcquireRunResult> {
    const result = await this.post(
      "acquire-run",
      {
        request_id: input.requestId,
        agent_id: input.agentId,
        session_id: input.sessionId,
      },
      acquireSchema,
      signal,
    );
    return {
      admissionId: result.admission_id,
      admissionDeadline: new Date(result.admission_deadline),
      agentConfigRevision: result.agent_config_revision,
      executionRevision: result.execution_revision,
      runtimeMcpSourceDigest: result.runtime_mcp_source_digest,
      agentExecutionSpecDigest: result.agent_execution_spec_digest,
      credentialVersion: result.credential_version,
      runtime: {
        generation: result.runtime.runtime_generation,
        instanceId: result.runtime.runtime_instance_id,
        executionId: result.runtime.runtime_execution_id,
        mcpEndpoint: result.runtime.mcp_endpoint,
      },
      executionSpec: {
        systemPrompt: result.execution_spec.system_prompt,
        skillInstructions: result.execution_spec.skill_instructions.map((skill) => ({
          skillKey: skill.skill_key,
          version: skill.version,
          instructions: skill.instructions,
        })),
        model: {
          adapter: result.execution_spec.model.adapter,
          baseUrl: result.execution_spec.model.base_url,
          model: result.execution_spec.model.model,
          contextWindow: result.execution_spec.model.context_window,
          maxOutputTokens: result.execution_spec.model.max_output_tokens,
          ...(result.execution_spec.model.temperature === undefined
            ? {}
            : { temperature: result.execution_spec.model.temperature }),
          supportsImages: result.execution_spec.model.supports_images,
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
        executor_state: input.executorState,
        runtime_effect_state: input.runtimeEffectState,
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
      if (parsed.success) {
        throw new AgentControllerError(
          parsed.data.code,
          parsed.data.message,
          parsed.data.retryable,
        );
      }
      throw new AgentControllerError(
        "dependency_unavailable",
        `Agent Controller returned HTTP ${response.status}`,
        response.status >= 500,
      );
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
    return await response.json();
  } catch (error) {
    throw dependencyUnavailable("Agent Controller returned a non-JSON response", error);
  }
}

function propagatedHeaders(withBody: boolean): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (withBody) {
    headers.set("content-type", "application/json");
  }
  const traceHeaders: Record<string, string> = {};
  propagation.inject(context.active(), traceHeaders);
  for (const [name, value] of Object.entries(traceHeaders)) {
    headers.set(name, value);
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
