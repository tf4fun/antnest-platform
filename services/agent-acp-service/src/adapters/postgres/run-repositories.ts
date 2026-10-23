import type { PostgresKernel } from "./kernel.js";
import { PostgresRunRepository } from "./run-repository.js";
import { PostgresRunEventRepository } from "./run-event-repository.js";
import { PostgresExecutionRepository } from "./execution-repository.js";
import { PostgresContextRepository } from "./context-repository.js";
import { RunWriteAuthority, type RunOwnerAuthority } from "./run-write-authority.js";

export function createOwnedRunRepositories(kernel: PostgresKernel, input: RunOwnerAuthority) {
  return createBoundRunRepositories(kernel, RunWriteAuthority.owned(input));
}

export function createLegacyRunRepositories(kernel: PostgresKernel, workerOwnership: AbortSignal) {
  return createBoundRunRepositories(kernel, RunWriteAuthority.legacy(workerOwnership));
}

export function createBoundRunRepositories(kernel: PostgresKernel, authority: RunWriteAuthority) {
  return Object.freeze({
    runs: new PostgresRunRepository(kernel, authority),
    events: new PostgresRunEventRepository(kernel, authority),
    executions: new PostgresExecutionRepository(kernel, authority),
    contexts: new PostgresContextRepository(kernel, authority),
  });
}
