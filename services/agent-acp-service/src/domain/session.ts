import { DomainError } from "./errors.js";
import type {
  ConnectionBinding,
  EnvironmentChangeFact,
  RunExecutionSnapshot,
  SessionRecord,
} from "./types.js";

const WORKSPACE = "/workspace";
const ENVIRONMENT_CHANGE_CONTENT =
  "The Agent configuration or isolated execution environment was rebuilt after the previous " +
  "Run. Persisted workspace and conversation state remain available. Temporary processes, " +
  "/tmp data, ports, and in-memory handles may no longer exist. Re-check transient state " +
  "before relying on it.";

export function requireWorkspace(cwd: string, additionalDirectories: readonly string[]): void {
  if (cwd !== WORKSPACE) {
    throw new DomainError("unsupported_workspace", `ACP cwd must be ${WORKSPACE}`);
  }
  if (additionalDirectories.length > 0) {
    throw new DomainError(
      "unsupported_workspace",
      "ACP additional directories are not supported by this Agent",
    );
  }
}

export function authorizeSession(session: SessionRecord, binding: ConnectionBinding): void {
  if (session.principalId !== binding.principalId) {
    throw new DomainError("session_access_denied", "Session belongs to another principal");
  }
  if (session.agentId !== binding.agentId) {
    throw new DomainError("session_access_denied", "Session belongs to another Agent");
  }
  if (session.state === "deleted") {
    throw new DomainError("session_not_found", "Session has been deleted");
  }
}

export function requireActiveSession(session: SessionRecord): void {
  if (session.state !== "active") {
    throw new DomainError("session_not_active", "Session is not active");
  }
}

export function environmentChangeFact(
  session: SessionRecord,
  snapshot: RunExecutionSnapshot,
): EnvironmentChangeFact | null {
  const previous = session.lastExecutionRevision;
  if (previous === null || previous === snapshot.executionRevision) {
    return null;
  }
  return {
    kind: "environment_change",
    visible: false,
    content: ENVIRONMENT_CHANGE_CONTENT,
    previousExecutionRevision: previous,
    currentExecutionRevision: snapshot.executionRevision,
  };
}
