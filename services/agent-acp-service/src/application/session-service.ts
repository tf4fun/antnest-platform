import { DomainError } from "../domain/errors.js";
import { normalizeClientMcpServers } from "../domain/mcp.js";
import { authorizeSession, requireWorkspace } from "../domain/session.js";
import type { AcpApplicationPort } from "../ports/acp-application.js";
import type { SessionRepository } from "../ports/session-repository.js";

export type SessionServiceDependencies = {
  repository: SessionRepository;
  id: () => string;
  now: () => Date;
};

export class SessionService implements Pick<
  AcpApplicationPort,
  "createSession" | "listSessions" | "deleteSession" | "resumeSession" | "closeSession"
> {
  public constructor(private readonly dependencies: SessionServiceDependencies) {}

  public async createSession(
    input: Parameters<AcpApplicationPort["createSession"]>[0],
  ): Promise<{ sessionId: string }> {
    requireWorkspace(input.cwd, input.additionalDirectories);
    const sessionId = this.dependencies.id();
    await this.dependencies.repository.create({
      sessionId,
      binding: input.binding,
      cwd: "/workspace",
      mcpRevisionId: this.dependencies.id(),
      mcpSources: normalizeClientMcpServers(input.mcpServers),
    });
    return { sessionId };
  }

  public async listSessions(
    input: Parameters<AcpApplicationPort["listSessions"]>[0],
  ): Promise<Awaited<ReturnType<AcpApplicationPort["listSessions"]>>> {
    if (input.cwd !== undefined) {
      requireWorkspace(input.cwd, []);
    }
    const result = await this.dependencies.repository.list({
      principalId: input.binding.principalId,
      agentId: input.binding.agentId,
      cwd: input.cwd,
      cursor: input.cursor,
      limit: 50,
    });
    return {
      sessions: result.sessions.map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        updatedAt: session.updatedAt.toISOString(),
      })),
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    };
  }

  public async resumeSession(
    input: Parameters<AcpApplicationPort["resumeSession"]>[0],
  ): Promise<Awaited<ReturnType<AcpApplicationPort["resumeSession"]>>> {
    requireWorkspace(input.cwd, input.additionalDirectories);
    const session = await this.requireAuthorized(input.sessionId, input.binding);
    if (session.cwd !== input.cwd) {
      throw new DomainError("session_workspace_mismatch", "Session belongs to another workspace");
    }
    await this.dependencies.repository.replaceMcpAndActivate({
      sessionId: session.id,
      mcpRevisionId: this.dependencies.id(),
      mcpSources: normalizeClientMcpServers(input.mcpServers),
    });
    const replay = input.replayFromStart
      ? await this.dependencies.repository.replay(session.id)
      : [];
    replay.push(await this.dependencies.repository.getCurrentRunState(session.id));
    return { replay };
  }

  public async closeSession(
    input: Parameters<AcpApplicationPort["closeSession"]>[0],
  ): Promise<void> {
    const session = await this.requireAuthorized(input.sessionId, input.binding);
    await this.dependencies.repository.close(session.id, this.dependencies.now());
  }

  public async deleteSession(
    input: Parameters<AcpApplicationPort["deleteSession"]>[0],
  ): Promise<void> {
    const session = await this.requireAuthorized(input.sessionId, input.binding);
    await this.dependencies.repository.delete(session.id, this.dependencies.now());
  }

  public async requestCancellation(
    sessionId: string,
    binding: Parameters<AcpApplicationPort["createSession"]>[0]["binding"],
  ): Promise<void> {
    const session = await this.requireAuthorized(sessionId, binding);
    await this.dependencies.repository.requestCancellation(session.id, this.dependencies.now());
  }

  public async requireAuthorized(
    sessionId: string,
    binding: Parameters<AcpApplicationPort["createSession"]>[0]["binding"],
  ) {
    const session = await this.dependencies.repository.get(sessionId);
    if (session === null) {
      throw new DomainError("session_not_found", "Session does not exist");
    }
    authorizeSession(session, binding);
    return session;
  }
}
