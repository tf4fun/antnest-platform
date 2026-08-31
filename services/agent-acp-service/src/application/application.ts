import type {
  AcpApplicationPort,
  AcceptedAcpRun,
  ExecuteRunResult,
} from "../ports/acp-application.js";
import type { PromptCoordinator } from "./prompt-coordinator.js";
import type { RunLifecyclePort } from "./run-supervisor.js";
import type { SessionService } from "./session-service.js";

export type AcpApplicationDependencies = {
  sessions: SessionService;
  prompts: PromptCoordinator;
  runs: RunLifecyclePort;
};

export class AcpApplication implements AcpApplicationPort {
  public constructor(private readonly dependencies: AcpApplicationDependencies) {}

  public createSession(
    input: Parameters<AcpApplicationPort["createSession"]>[0],
  ): ReturnType<AcpApplicationPort["createSession"]> {
    return this.dependencies.sessions.createSession(input);
  }

  public listSessions(
    input: Parameters<AcpApplicationPort["listSessions"]>[0],
  ): ReturnType<AcpApplicationPort["listSessions"]> {
    return this.dependencies.sessions.listSessions(input);
  }

  public async deleteSession(
    input: Parameters<AcpApplicationPort["deleteSession"]>[0],
  ): Promise<void> {
    await this.dependencies.sessions.deleteSession(input);
    await this.dependencies.runs.cancel(input.sessionId);
  }

  public resumeSession(
    input: Parameters<AcpApplicationPort["resumeSession"]>[0],
  ): ReturnType<AcpApplicationPort["resumeSession"]> {
    return this.dependencies.sessions.resumeSession(input);
  }

  public async closeSession(
    input: Parameters<AcpApplicationPort["closeSession"]>[0],
  ): Promise<void> {
    await this.dependencies.sessions.closeSession(input);
    await this.dependencies.runs.cancel(input.sessionId);
  }

  public async cancelRun(input: Parameters<AcpApplicationPort["cancelRun"]>[0]): Promise<void> {
    await this.dependencies.sessions.requestCancellation(input.sessionId, input.binding);
    await this.dependencies.runs.cancel(input.sessionId);
  }

  public async acceptPrompt(
    input: Parameters<AcpApplicationPort["acceptPrompt"]>[0],
  ): Promise<AcceptedAcpRun> {
    return this.dependencies.runs.admit(input.sessionId, (signal) =>
      this.dependencies.prompts.accept(input, signal),
    );
  }

  public executeRun(
    input: Parameters<AcpApplicationPort["executeRun"]>[0],
  ): Promise<ExecuteRunResult> {
    return this.dependencies.runs.execute(input);
  }
}
