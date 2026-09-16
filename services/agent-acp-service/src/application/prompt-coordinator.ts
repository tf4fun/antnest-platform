import { DomainError } from "../domain/errors.js";
import { normalizePromptResources } from "../domain/embedded-resource.js";
import { matchCommand, type SessionCommand } from "../domain/slash-commands.js";
import {
  authorizeSession,
  defaultSessionTitle,
  environmentChangeFact,
  requireActiveSession,
} from "../domain/session.js";
import type {
  AgentConfiguration,
  PublicExecutionConfiguration,
} from "../domain/execution-configuration.js";
import { runSnapshot } from "../domain/run-snapshot.js";
import type { ConnectionBinding, ContentBlock, RunExecutionSnapshot } from "../domain/types.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { RuntimeProtectionRepository } from "../ports/execution-repository.js";
import type { ExecutionDirectory } from "./execution-directory.js";

export type PromptCoordinatorDependencies = {
  repository: RunRepository;
  directory: ExecutionDirectory;
  protection: RuntimeProtectionRepository;
  runTimeoutMs: number;
  recoveryRequired: (error: Error) => void;
  id: () => string;
  now: () => Date;
};

export type AcceptPromptInput = {
  binding: ConnectionBinding;
  sessionId: string;
  prompt: ContentBlock[];
};

export type AcceptedRun = {
  outputSequence: number;
  command?: SessionCommand;
  runId: string;
  requestId: string;
  sessionId: string;
  userMessageId: string;
  snapshot: RunExecutionSnapshot;
};

export class PromptCoordinator {
  public constructor(private readonly dependencies: PromptCoordinatorDependencies) {
    if (!Number.isSafeInteger(dependencies.runTimeoutMs) || dependencies.runTimeoutMs <= 0) {
      throw new Error("Run timeout must be a positive safe integer");
    }
  }

  public accept(
    input: AcceptPromptInput,
    signal = new AbortController().signal,
  ): Promise<AcceptedRun> {
    return this.dependencies.directory.withAccess(input.binding, ({ agent, configuration }) =>
      this.acceptConfigured(input, agent, configuration, signal),
    );
  }

  private async acceptConfigured(
    input: AcceptPromptInput,
    agent: AgentConfiguration,
    configuration: PublicExecutionConfiguration,
    signal: AbortSignal,
  ): Promise<AcceptedRun> {
    const session = await this.dependencies.repository.getSession(input.sessionId);
    if (session === null) throw new DomainError("session_not_found", "Session does not exist");
    authorizeSession(session, input.binding);
    requireActiveSession(session);
    throwIfCancelled(signal);
    if (!agent.accepting_runs) {
      throw new DomainError(
        "agent_unavailable",
        agent.unavailable_reason ?? "Agent is unavailable",
      );
    }
    if (
      await this.dependencies.protection.hasUnstoppedRuntimeCalls(
        {
          organizationId: input.binding.organizationId,
          agentId: input.binding.agentId,
          runtimeRevision: agent.runtime?.runtime_revision ?? null,
        },
        signal,
      )
    ) {
      throw new DomainError(
        "runtime_barrier_required",
        "Previous Runtime execution may still be active; rebuild the Agent before starting new work",
      );
    }
    throwIfCancelled(signal);
    const runId = this.dependencies.id();
    const requestId = this.dependencies.id();
    const userMessageId = this.dependencies.id();
    const now = this.dependencies.now();
    const intent = await this.persist(() =>
      this.dependencies.repository.createRunIntent({
        runId,
        requestId,
        sessionId: session.id,
        expectedAccessRevision: agent.access_revision,
        userMessageId,
        prompt: normalizePromptResources(input.prompt),
        createdAt: now,
      }),
    );

    let snapshot: RunExecutionSnapshot;
    try {
      throwIfCancelled(signal);
      snapshot = runSnapshot({
        configuration,
        identity: input.binding,
        overrides: intent.sessionConfiguration ?? {},
        accessRevision: agent.access_revision,
        clientMcpRevisionId: intent.clientMcpRevisionId,
        deadlineAt: new Date(now.getTime() + this.dependencies.runTimeoutMs),
      });
    } catch (error) {
      await this.persist(async () => {
        if (signal.aborted)
          await this.dependencies.repository.requestCancellation(runId, this.dependencies.now());
        return this.dependencies.repository.rejectRun(
          runId,
          error instanceof DomainError ? error.code : "invalid_execution_configuration",
          this.dependencies.now(),
        );
      });
      throw error;
    }

    const acceptedAt = this.dependencies.now();
    const title = session.title ?? defaultSessionTitle(input.prompt);
    const disposition = await this.persist(() =>
      this.dependencies.repository.acceptRun({
        runId,
        snapshot,
        environmentFact: environmentChangeFact(session, snapshot),
        ...(title === undefined ? {} : { sessionTitle: title }),
        acceptedAt,
      }),
    );
    if (disposition === "cancelled") throw cancelledError();
    const command = matchCommand(intent.prompt);
    return {
      outputSequence: session.lastMessageSequence,
      ...(command === undefined ? {} : { command }),
      runId,
      requestId,
      sessionId: session.id,
      userMessageId,
      snapshot,
    };
  }

  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof DomainError)) {
        this.dependencies.recoveryRequired(
          new Error("Run acceptance could not be persisted locally", { cause: error }),
        );
      }
      throw error;
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError();
}

function cancelledError(): DomainError {
  return new DomainError("run_cancelled", "Run was cancelled before execution");
}
