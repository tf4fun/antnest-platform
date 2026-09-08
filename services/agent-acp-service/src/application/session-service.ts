import { DomainError } from "../domain/errors.js";
import { requireNoClientMcpServers } from "../domain/mcp.js";
import { authorizeSession, authorizeSessionOwner, requireWorkspace } from "../domain/session.js";
import type { AcpApplicationPort } from "../ports/acp-application.js";
import type { SessionRepository } from "../ports/session-repository.js";

export type SessionServiceDependencies = {
  repository: SessionRepository;
  id: () => string;
  now: () => Date;
};

export class SessionService implements Pick<
  AcpApplicationPort,
  | "createSession"
  | "listSessions"
  | "deleteSession"
  | "forkSession"
  | "resumeSession"
  | "closeSession"
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
      mcpSources: requireNoClientMcpServers(input.mcpServers),
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
        ...(session.title === null ? {} : { title: session.title }),
        updatedAt: session.updatedAt.toISOString(),
      })),
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    };
  }

  public async forkSession(
    input: Parameters<AcpApplicationPort["forkSession"]>[0],
  ): Promise<{ sessionId: string }> {
    requireWorkspace(input.cwd, input.additionalDirectories);
    const source = await this.requireAuthorized(input.sessionId, input.binding);
    if (source.cwd !== input.cwd) {
      throw new DomainError("session_workspace_mismatch", "Session belongs to another workspace");
    }
    const sessionId = this.dependencies.id();
    await this.dependencies.repository.fork({
      sourceSessionId: source.id,
      sessionId,
      mcpRevisionId: this.dependencies.id(),
      mcpSources: requireNoClientMcpServers(input.mcpServers),
      createdAt: this.dependencies.now(),
    });
    return { sessionId };
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
      mcpSources: requireNoClientMcpServers(input.mcpServers),
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
    const session = await this.dependencies.repository.get(input.sessionId);
    if (session === null) return;
    authorizeSessionOwner(session, input.binding);
    if (session.state === "deleted") return;
    await this.dependencies.repository.delete(session.id, this.dependencies.now());
  }

  public async requestCancellation(
    sessionId: string,
    binding: Parameters<AcpApplicationPort["createSession"]>[0]["binding"],
  ): Promise<void> {
    const session = await this.requireAuthorized(sessionId, binding);
    await this.dependencies.repository.requestCancellation(session.id, this.dependencies.now());
  }

  public async requirePromptSession(
    sessionId: string,
    binding: Parameters<AcpApplicationPort["createSession"]>[0]["binding"],
  ): Promise<void> {
    const session = await this.requireAuthorized(sessionId, binding);
    const sources = await this.dependencies.repository.getClientMcpRevision(
      session.clientMcpRevisionId,
    );
    requireNoClientMcpServers(sources);
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
