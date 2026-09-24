import type { RunExecutionPort } from "../application/run-executor.js";
import type {
  AcpApplicationPort,
  ExecuteRunResult,
  RunExecutionInput,
} from "../ports/acp-application.js";
import type { RuntimeInformationPort } from "../ports/runtime-information.js";
import { DomainError } from "../domain/errors.js";
import { safeError } from "./diagnostics.js";
import type {
  AuthenticatedModelTransport,
  AuthenticatedModelRequest,
  ModelResult,
} from "../ports/model.js";
import type { TelemetryAttributes, TelemetryPort } from "../ports/telemetry.js";
import type { ToolCallInput, ToolCallResult, ToolCatalogPort } from "../ports/tools.js";
import { context, trace } from "@opentelemetry/api";
import {
  modelRequest,
  modelResponse,
  toolRequest,
  recordResult,
  resultOutcome,
  snapshotAttributes,
} from "./projections.js";

export class InstrumentedAcpApplication implements AcpApplicationPort {
  public constructor(
    private readonly delegate: AcpApplicationPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  public getSessionConfiguration(
    input: Parameters<AcpApplicationPort["getSessionConfiguration"]>[0],
  ) {
    return this.sessionOperation("get_configuration", input.binding.agentId, input.sessionId, () =>
      this.delegate.getSessionConfiguration(input),
    );
  }

  public setSessionConfiguration(
    input: Parameters<AcpApplicationPort["setSessionConfiguration"]>[0],
  ) {
    return this.sessionOperation("set_configuration", input.binding.agentId, input.sessionId, () =>
      this.delegate.setSessionConfiguration(input),
    );
  }

  public assertAccess(
    input: Parameters<AcpApplicationPort["assertAccess"]>[0],
  ): ReturnType<AcpApplicationPort["assertAccess"]> {
    return this.delegate.assertAccess(input);
  }

  public readSessionOutput(input: Parameters<AcpApplicationPort["readSessionOutput"]>[0]) {
    return this.sessionOperation(
      "output",
      input.binding.agentId,
      input.sessionId,
      () => this.delegate.readSessionOutput(input),
      "read",
    );
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
      {
        "agent.id": input.binding.agentId,
        "session.id": input.sessionId,
        "antnest.operation.phase": "admit",
      },
      "antnest.acp.session_method.duration",
      "antnest.acp.session_methods",
      { method: "prompt" },
      async () => {
        try {
          const accepted = await this.delegate.acceptPrompt(input);
          this.telemetry.count("antnest.acp.run_admissions", { result: "accepted" });
          return accepted;
        } catch (error) {
          if (input.bridgeIntent !== undefined && error instanceof DomainError) {
            const result =
              error.code === "intent_already_recorded"
                ? "hit"
                : error.code === "idempotency_conflict"
                  ? "conflict"
                  : null;
            if (result !== null)
              this.telemetry.count("antnest.acp.bridge_intent_reuse", { result });
          }
          this.telemetry.count("antnest.acp.run_admissions", {
            result: "rejected",
            rejection_class: rejectionClass(error),
          });
          throw error;
        }
      },
    );
  }

  private sessionOperation<Result>(
    method: string,
    agentId: string,
    sessionId: string | undefined,
    operation: () => Promise<Result>,
    phase?: string,
  ): Promise<Result> {
    return observe(
      this.telemetry,
      `acp.session.${method}`,
      {
        "agent.id": agentId,
        "session.id": sessionId,
        ...(phase ? { "antnest.operation.phase": phase } : {}),
      },
      "antnest.acp.session_method.duration",
      "antnest.acp.session_methods",
      { method },
      operation,
    );
  }
}

export class InstrumentedRunExecutor implements RunExecutionPort {
  public constructor(
    private readonly delegate: RunExecutionPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  public execute(input: RunExecutionInput): Promise<ExecuteRunResult> {
    const started = performance.now();
    let terminalClass = "executor_error";
    const attributes = {
      "run.id": input.accepted.runId,
      "session.id": input.accepted.sessionId,
      "organization.id": input.accepted.snapshot.organizationId,
      "execution.revision": input.accepted.snapshot.executionRevision,
    };
    return this.telemetry
      .span("agent.run", attributes, async () => {
        trace.getSpan(context.active())?.setAttributes({
          ...snapshotAttributes(input.accepted.snapshot),
          "antnest.request.id": input.accepted.requestId,
          "antnest.run.id": input.accepted.runId,
          "antnest.session.id": input.accepted.sessionId,
          "antnest.operation.phase": "execute",
        });

        let result: ExecuteRunResult;
        try {
          result = await this.delegate.execute(input);
        } catch (error) {
          this.telemetry.count("antnest.acp.runs", { terminal_class: "executor_error" });
          throw error;
        }
        terminalClass = result.terminalClass;
        trace.getSpan(context.active())?.setAttributes({
          "run.terminal_class": result.terminalClass,
          "run.executor_state": result.executorState,
          "run.tool_effect_state": result.toolEffectState,
          "run.unknown_effect_source": result.unknownEffectSource,
        });
        recordResult(result);

        this.telemetry.count("antnest.acp.runs", { terminal_class: result.terminalClass });
        return result;
      })
      .finally(() => {
        this.telemetry.duration("antnest.acp.run.duration", performance.now() - started, {
          terminal_class: terminalClass,
        });
      });
  }
}

function rejectionClass(error: unknown): string {
  if (!(error instanceof DomainError)) return "internal_error";
  const code = safeError(error).code;
  return typeof code === "string" ? code : "internal_error";
}

export class InstrumentedModel implements AuthenticatedModelTransport {
  public constructor(
    private readonly delegate: AuthenticatedModelTransport,
    private readonly telemetry: TelemetryPort,
  ) {}

  public complete(request: AuthenticatedModelRequest): Promise<ModelResult> {
    return observe(
      this.telemetry,
      "model.complete",
      {
        "organization.id": request.snapshot.organizationId,
        "agent.spec_revision": request.snapshot.agentSpecRevision,
        "execution.revision": request.snapshot.executionRevision,
        "model.name": request.snapshot.executionSpec.model.model,
        "model.purpose": request.purpose ?? "response",
      },
      "antnest.acp.model.duration",
      "antnest.acp.model.requests",
      { protocol: "openai_chat_completions" },
      async () => {
        modelRequest(request);
        const result = await this.delegate.complete(request);
        modelResponse(result);
        return result;
      },
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
      {
        "organization.id": snapshot.organizationId,
        "execution.revision": snapshot.executionRevision,
      },
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
      {
        "organization.id": snapshot.organizationId,
        "execution.revision": snapshot.executionRevision,
      },
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
        "organization.id": input.snapshot.organizationId,
        "tool.name": input.tool.modelName,
        "mcp.source_id": input.tool.sourceId,
      },
      "antnest.acp.mcp.duration",
      "antnest.acp.mcp.requests",
      { operation: "call", source: input.tool.source },
      async () => {
        toolRequest(input);
        const result = await this.delegate.call(input);
        return result;
      },
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
      recordResult(result);
      telemetry.count(requestMetric, {
        ...metricAttributes,
        result: resultOutcome(result) === "ok" ? "ok" : "error",
      });
      return result;
    } catch (error) {
      telemetry.count(requestMetric, { ...metricAttributes, result: "error" });
      throw error;
    } finally {
      telemetry.duration(durationMetric, performance.now() - started, metricAttributes);
    }
  });
}
