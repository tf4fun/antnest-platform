import type { AcpApplicationPort, ExecuteRunResult } from "../ports/acp-application.js";
import type { RuntimeInformationPort } from "../ports/runtime-information.js";
import { DomainError } from "../domain/errors.js";
import { AgentControllerError, isAgentControllerErrorCode } from "../ports/agent-controller.js";
import type {
  AgentControllerPort,
  AcquireRunInput,
  AcquireRunResult,
  FinishRunInput,
  ResolveAgentAccessInput,
  ResolveAgentAccessResult,
  ResolveCredentialInput,
  ResolveCredentialResult,
} from "../ports/agent-controller.js";
import type { ModelPort, ModelRequest, ModelResult } from "../ports/model.js";
import type { TelemetryAttributes, TelemetryPort } from "../ports/telemetry.js";
import type { ToolCallInput, ToolCallResult, ToolCatalogPort } from "../ports/tools.js";

export class InstrumentedAcpApplication implements AcpApplicationPort {
  public constructor(
    private readonly delegate: AcpApplicationPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  public assertAccess(
    input: Parameters<AcpApplicationPort["assertAccess"]>[0],
  ): ReturnType<AcpApplicationPort["assertAccess"]> {
    return this.delegate.assertAccess(input);
  }

  public createSession(
    input: Parameters<AcpApplicationPort["createSession"]>[0],
  ): ReturnType<AcpApplicationPort["createSession"]> {
    return this.sessionOperation("new", input.binding.agentId, undefined, () =>
      this.delegate.createSession(input),
    );
  }

  public listSessions(
    input: Parameters<AcpApplicationPort["listSessions"]>[0],
  ): ReturnType<AcpApplicationPort["listSessions"]> {
    return this.sessionOperation("list", input.binding.agentId, undefined, () =>
      this.delegate.listSessions(input),
    );
  }

  public deleteSession(
    input: Parameters<AcpApplicationPort["deleteSession"]>[0],
  ): ReturnType<AcpApplicationPort["deleteSession"]> {
    return this.sessionOperation("delete", input.binding.agentId, input.sessionId, () =>
      this.delegate.deleteSession(input),
    );
  }

  public forkSession(
    input: Parameters<AcpApplicationPort["forkSession"]>[0],
  ): ReturnType<AcpApplicationPort["forkSession"]> {
    return this.sessionOperation("fork", input.binding.agentId, input.sessionId, () =>
      this.delegate.forkSession(input),
    );
  }

  public resumeSession(
    input: Parameters<AcpApplicationPort["resumeSession"]>[0],
  ): ReturnType<AcpApplicationPort["resumeSession"]> {
    return this.sessionOperation("resume", input.binding.agentId, input.sessionId, () =>
      this.delegate.resumeSession(input),
    );
  }

  public closeSession(
    input: Parameters<AcpApplicationPort["closeSession"]>[0],
  ): ReturnType<AcpApplicationPort["closeSession"]> {
    return this.sessionOperation("close", input.binding.agentId, input.sessionId, () =>
      this.delegate.closeSession(input),
    );
  }

  public cancelRun(
    input: Parameters<AcpApplicationPort["cancelRun"]>[0],
  ): ReturnType<AcpApplicationPort["cancelRun"]> {
    return this.sessionOperation("cancel", input.binding.agentId, input.sessionId, () =>
      this.delegate.cancelRun(input),
    );
  }

  public acceptPrompt(
    input: Parameters<AcpApplicationPort["acceptPrompt"]>[0],
  ): ReturnType<AcpApplicationPort["acceptPrompt"]> {
    return observe(
      this.telemetry,
      "acp.session.prompt",
      { "agent.id": input.binding.agentId, "session.id": input.sessionId },
      "antnest.acp.session_method.duration",
      "antnest.acp.session_methods",
      { method: "prompt" },
      async () => {
        try {
          const accepted = await this.delegate.acceptPrompt(input);
          this.telemetry.count("antnest.acp.run_admissions", { result: "accepted" });
          return accepted;
        } catch (error) {
          this.telemetry.count("antnest.acp.run_admissions", {
            result: "rejected",
            rejection_class: rejectionClass(error),
          });
          throw error;
        }
      },
    );
  }

  public executeRun(
    input: Parameters<AcpApplicationPort["executeRun"]>[0],
  ): ReturnType<AcpApplicationPort["executeRun"]> {
    const started = performance.now();
    let terminalClass = "executor_error";
    const attributes = {
      "run.id": input.accepted.runId,
      "session.id": input.accepted.sessionId,
      "admission.id": input.accepted.snapshot.admissionId,
      "execution.revision": input.accepted.snapshot.executionRevision,
    };
    return this.telemetry
      .span("agent.run", attributes, async () => {
        let result: ExecuteRunResult;
        try {
          result = await this.delegate.executeRun(input);
        } catch (error) {
          this.telemetry.count("antnest.acp.runs", { terminal_class: "executor_error" });
          throw error;
        }
        terminalClass = result.terminalClass;
        this.telemetry.count("antnest.acp.runs", { terminal_class: result.terminalClass });
        return result;
      })
      .finally(() => {
        this.telemetry.duration("antnest.acp.run.duration", performance.now() - started, {
          terminal_class: terminalClass,
        });
      });
  }

  private sessionOperation<Result>(
    method: string,
    agentId: string,
    sessionId: string | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return observe(
      this.telemetry,
      `acp.session.${method}`,
      { "agent.id": agentId, "session.id": sessionId },
      "antnest.acp.session_method.duration",
      "antnest.acp.session_methods",
      { method },
      operation,
    );
  }
}

function rejectionClass(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }
  if (error instanceof AgentControllerError) {
    return isAgentControllerErrorCode(error.code) ? error.code : "dependency_unavailable";
  }
  return "internal_error";
}

export class InstrumentedAgentController implements AgentControllerPort {
  public constructor(
    private readonly delegate: AgentControllerPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  public resolveAgentAccess(
    input: ResolveAgentAccessInput,
    signal?: AbortSignal,
  ): Promise<ResolveAgentAccessResult> {
    return this.rpc("resolve_agent_access", { "request.id": input.requestId }, () =>
      this.delegate.resolveAgentAccess(input, signal),
    );
  }

  public acquireRun(input: AcquireRunInput, signal?: AbortSignal): Promise<AcquireRunResult> {
    return this.rpc(
      "acquire_run",
      { "request.id": input.requestId, "agent.id": input.agentId, "session.id": input.sessionId },
      () => this.delegate.acquireRun(input, signal),
    );
  }

  public resolveCredential(
    input: ResolveCredentialInput,
    signal?: AbortSignal,
  ): Promise<ResolveCredentialResult> {
    return this.rpc(
      "resolve_credential",
      { "request.id": input.requestId, "admission.id": input.admissionId },
      () => this.delegate.resolveCredential(input, signal),
    );
  }

  public finishRun(input: FinishRunInput, signal?: AbortSignal): Promise<void> {
    return this.rpc(
      "finish_run",
      {
        "request.id": input.requestId,
        "admission.id": input.admissionId,
        "run.terminal_class": input.terminalClass,
        "run.tool_effect_state": input.toolEffectState,
        "run.unknown_effect_source": input.unknownEffectSource,
      },
      () => this.delegate.finishRun(input, signal),
    );
  }

  private rpc<Result>(
    method: string,
    spanAttributes: TelemetryAttributes,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return observe(
      this.telemetry,
      `agent_controller.${method}`,
      spanAttributes,
      "antnest.acp.agent_controller.duration",
      "antnest.acp.agent_controller.requests",
      { method },
      operation,
    );
  }
}

export class InstrumentedModel implements ModelPort {
  public constructor(
    private readonly delegate: ModelPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  public complete(request: ModelRequest): Promise<ModelResult> {
    return observe(
      this.telemetry,
      "model.complete",
      {
        "admission.id": request.snapshot.admissionId,
        "agent.spec_revision": request.snapshot.agentSpecRevision,
        "execution.revision": request.snapshot.executionRevision,
        "model.name": request.snapshot.executionSpec.model.model,
      },
      "antnest.acp.model.duration",
      "antnest.acp.model.requests",
      { protocol: "openai_chat_completions" },
      () => this.delegate.complete(request),
    );
  }
}

export class InstrumentedRuntimeInformation implements RuntimeInformationPort {
  public constructor(
    private readonly delegate: RuntimeInformationPort,
    private readonly telemetry: TelemetryPort,
  ) {}
  public read(
    snapshot: Parameters<RuntimeInformationPort["read"]>[0],
    signal: AbortSignal,
  ): ReturnType<RuntimeInformationPort["read"]> {
    return observe(
      this.telemetry,
      "mcp.runtime.info",
      { "admission.id": snapshot.admissionId, "execution.revision": snapshot.executionRevision },
      "antnest.acp.mcp.duration",
      "antnest.acp.mcp.requests",
      { operation: "info", source: "runtime" },
      () => this.delegate.read(snapshot, signal),
    );
  }
}

export class InstrumentedToolCatalog implements ToolCatalogPort {
  public constructor(
    private readonly delegate: ToolCatalogPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  public list(
    snapshot: Parameters<ToolCatalogPort["list"]>[0],
    signal: AbortSignal,
  ): ReturnType<ToolCatalogPort["list"]> {
    return observe(
      this.telemetry,
      "mcp.tools.list",
      { "admission.id": snapshot.admissionId, "execution.revision": snapshot.executionRevision },
      "antnest.acp.mcp.duration",
      "antnest.acp.mcp.requests",
      { operation: "list", source: "all" },
      () => this.delegate.list(snapshot, signal),
    );
  }

  public call(input: ToolCallInput): Promise<ToolCallResult> {
    return observe(
      this.telemetry,
      "mcp.tools.call",
      {
        "run.id": input.runId,
        "admission.id": input.snapshot.admissionId,
        "tool.name": input.tool.modelName,
        "mcp.source_id": input.tool.sourceId,
      },
      "antnest.acp.mcp.duration",
      "antnest.acp.mcp.requests",
      { operation: "call", source: input.tool.source },
      () => this.delegate.call(input),
    );
  }
}

async function observe<Result>(
  telemetry: TelemetryPort,
  spanName: string,
  spanAttributes: TelemetryAttributes,
  durationMetric: string,
  requestMetric: string,
  metricAttributes: TelemetryAttributes,
  operation: () => Promise<Result>,
): Promise<Result> {
  const started = performance.now();
  return telemetry.span(spanName, spanAttributes, async () => {
    try {
      const result = await operation();
      telemetry.count(requestMetric, { ...metricAttributes, result: "ok" });
      return result;
    } catch (error) {
      telemetry.count(requestMetric, { ...metricAttributes, result: "error" });
      throw error;
    } finally {
      telemetry.duration(durationMetric, performance.now() - started, metricAttributes);
    }
  });
}
