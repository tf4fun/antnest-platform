import type { PostgresKernel } from "./kernel.js";
import type { SecretBox } from "./secret-box.js";
import { PostgresSessionRepository } from "./session-repository.js";
import { PostgresSessionConfiguration } from "./session-configuration.js";
import { createBoundRunRepositories } from "./run-repositories.js";
import { RunWriteAuthority, type RunOwnerAuthority } from "./run-write-authority.js";

export function createOwnedAgentRepositories(
  kernel: PostgresKernel,
  box: SecretBox,
  input: RunOwnerAuthority,
) {
  return repositories(kernel, box, RunWriteAuthority.owned(input));
}

export function createLegacyAgentRepositories(
  kernel: PostgresKernel,
  box: SecretBox,
  workerOwnership: AbortSignal,
) {
  return repositories(kernel, box, RunWriteAuthority.legacy(workerOwnership));
}

function repositories(kernel: PostgresKernel, box: SecretBox, authority: RunWriteAuthority) {
  return Object.freeze({
    ...createBoundRunRepositories(kernel, authority),
    sessions: new PostgresSessionRepository(kernel, box, authority),
    sessionConfiguration: new PostgresSessionConfiguration(kernel, authority),
  });
}
