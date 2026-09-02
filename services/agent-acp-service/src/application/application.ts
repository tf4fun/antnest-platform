import type {
  AcpApplicationPort,
  AcceptedAcpRun,
  ExecuteRunResult,
} from "../ports/acp-application.js";
import type { AccessService } from "./access-service.js";
import type { PromptCoordinator } from "./prompt-coordinator.js";
import type { RunLifecyclePort } from "./run-supervisor.js";
import type { SessionService } from "./session-service.js";

export type AcpApplicationDependencies = {
  access: AccessService;
  sessions: SessionService;
  prompts: PromptCoordinator;
  runs: RunLifecyclePort;
};

export class AcpApplication implements AcpApplicationPort {
  public constructor(private readonly dependencies: AcpApplicationDependencies) {}

  public assertAccess(input: Parameters<AcpApplicationPort["assertAccess"]>[0]): Promise<void> {
    return this.dependencies.access.assert(input.binding);
  }

  public async createSession(
    input: Parameters<AcpApplicationPort["createSession"]>[0],
  ): Promise<Awaited<ReturnType<AcpApplicationPort["createSession"]>>> {
    await this.assertAccess(input);
    return this.dependencies.sessions.createSession(input);
  }

  public async listSessions(
    input: Parameters<AcpApplicationPort["listSessions"]>[0],
  ): Promise<Awaited<ReturnType<AcpApplicationPort["listSessions"]>>> {
    await this.assertAccess(input);
    return this.dependencies.sessions.listSessions(input);
  }

  public async deleteSession(
    input: Parameters<AcpApplicationPort["deleteSession"]>[0],
  ): Promise<void> {
    await this.assertAccess(input);
    await this.dependencies.sessions.deleteSession(input);
    await this.dependencies.runs.cancel(input.sessionId);
  }

  public async forkSession(
    input: Parameters<AcpApplicationPort["forkSession"]>[0],
  ): Promise<Awaited<ReturnType<AcpApplicationPort["forkSession"]>>> {
    await this.assertAccess(input);
    return this.dependencies.sessions.forkSession(input);
  }

  public async resumeSession(
    input: Parameters<AcpApplicationPort["resumeSession"]>[0],
  ): Promise<Awaited<ReturnType<AcpApplicationPort["resumeSession"]>>> {
    await this.assertAccess(input);
    return this.dependencies.sessions.resumeSession(input);
  }

  public async closeSession(
    input: Parameters<AcpApplicationPort["closeSession"]>[0],
  ): Promise<void> {
    await this.assertAccess(input);
    await this.dependencies.sessions.closeSession(input);
    await this.dependencies.runs.cancel(input.sessionId);
  }

  public async cancelRun(input: Parameters<AcpApplicationPort["cancelRun"]>[0]): Promise<void> {
    await this.assertAccess(input);
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
