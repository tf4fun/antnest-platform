import { DomainError } from "../domain/errors.js";
import {
  authorizeSession,
  environmentChangeFact,
  requireActiveSession,
} from "../domain/session.js";
import type { ConnectionBinding, ContentBlock, RunExecutionSnapshot } from "../domain/types.js";
import type { AgentControllerPort } from "../ports/agent-controller.js";
import type { ExecutionRepository } from "../ports/execution-repository.js";
import type { RunRepository } from "../ports/run-repository.js";
import { admissionErrorClass, isDefinitiveAdmissionRejection } from "./run-admission.js";

export type PromptCoordinatorDependencies = {
  repository: RunRepository;
  agentController: AgentControllerPort;
  executions: Pick<ExecutionRepository, "markAdmissionFinished">;
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
  runId: string;
  requestId: string;
  sessionId: string;
  userMessageId: string;
  snapshot: RunExecutionSnapshot;
};

export class PromptCoordinator {
  public constructor(private readonly dependencies: PromptCoordinatorDependencies) {}

  public async accept(
    input: AcceptPromptInput,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AcceptedRun> {
    const session = await this.dependencies.repository.getSession(input.sessionId);
    if (session === null) {
      throw new DomainError("session_not_found", "Session does not exist");
    }
    authorizeSession(session, input.binding);
    requireActiveSession(session);
    throwIfCancelled(signal);

    const runId = this.dependencies.id();
    const requestId = this.dependencies.id();
    const userMessageId = this.dependencies.id();
    const now = this.dependencies.now();
    const intent = await this.dependencies.repository.createRunIntent({
      runId,
      requestId,
      sessionId: session.id,
      expectedAccessRevision: input.binding.accessRevision,
      userMessageId,
      prompt: input.prompt,
      createdAt: now,
    });
    if (signal.aborted) {
      await this.cancelIntent(runId);
      throw cancelledError();
    }

    let acquired;
    try {
      acquired = await this.dependencies.agentController.acquireRun(
        {
          requestId,
          agentId: input.binding.agentId,
          principalId: input.binding.principalId,
          expectedAccessRevision: intent.expectedAccessRevision,
          sessionId: session.id,
        },
        signal,
      );
    } catch (error) {
      if (isDefinitiveAdmissionRejection(error)) {
        const disposition = await this.reject(runId, error, now);
        if (disposition === "cancelled") {
          throw cancelledError();
        }
      } else {
        this.dependencies.recoveryRequired(
          new Error("Run admission outcome requires startup recovery", { cause: error }),
        );
      }
      throw error;
    }

    const snapshot: RunExecutionSnapshot = {
      ...acquired,
      clientMcpRevisionId: intent.clientMcpRevisionId,
    };
    if (isCancellationRequested(signal)) {
      await this.dependencies.repository.requestCancellation(runId, this.dependencies.now());
    }
    // If local acceptance fails, the durable intent remains admitting so recovery
    // can repeat acquire_run with the same request ID.
    try {
      const disposition = await this.dependencies.repository.acceptRun({
        runId,
        snapshot,
        environmentFact: environmentChangeFact(session, snapshot),
        acceptedAt: this.dependencies.now(),
      });
      if (disposition === "cancelled") {
        await this.closeCancelledAdmission(runId, snapshot.admissionId);
        throw cancelledError();
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === "run_cancelled") {
        throw error;
      }
      this.dependencies.recoveryRequired(
        new Error("Admitted Run could not be committed locally", { cause: error }),
      );
      throw error;
    }

    return { runId, requestId, sessionId: session.id, userMessageId, snapshot };
  }

  private async reject(runId: string, error: unknown, at: Date): Promise<"failed" | "cancelled"> {
    return this.dependencies.repository.rejectRun(runId, admissionErrorClass(error), at);
  }

  private async cancelIntent(runId: string): Promise<void> {
    const at = this.dependencies.now();
    await this.dependencies.repository.requestCancellation(runId, at);
    await this.dependencies.repository.rejectRun(runId, "run_cancelled", at);
  }

  private async closeCancelledAdmission(runId: string, admissionId: string): Promise<void> {
    try {
      await this.dependencies.agentController.finishRun({
        requestId: this.dependencies.id(),
        admissionId,
        terminalClass: "cancelled",
        executorState: "quiescent",
        toolEffectState: "none",
      });
    } catch (error) {
      this.dependencies.recoveryRequired(
        new Error("Cancelled Run admission closure requires startup recovery", { cause: error }),
      );
      return;
    }
    try {
      await this.dependencies.executions.markAdmissionFinished(runId, this.dependencies.now());
    } catch (error) {
      this.dependencies.recoveryRequired(
        new Error("Cancelled Run closure marker requires startup recovery", { cause: error }),
      );
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

function isCancellationRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function cancelledError(): DomainError {
  return new DomainError("run_cancelled", "Run was cancelled during admission");
}
