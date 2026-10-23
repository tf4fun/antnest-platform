import type { PostgresKernel } from "./kernel.js";
import { PostgresRunRepository } from "./run-repository.js";
import { RunWriteAuthority, type RunOwnerAuthority } from "./run-write-authority.js";

export function createOwnedRunRepositories(kernel: PostgresKernel, input: RunOwnerAuthority) {
  const runs = new PostgresRunRepository(kernel, RunWriteAuthority.owned(input));
  return Object.freeze({ runs });
}

export function createLegacyRunRepositories(kernel: PostgresKernel, workerOwnership: AbortSignal) {
  const runs = new PostgresRunRepository(kernel, RunWriteAuthority.legacy(workerOwnership));
  return Object.freeze({ runs });
}
