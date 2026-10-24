import type { PostgresKernel } from "./kernel.js";
import { RunWriteAuthority, type RunOwnerAuthority } from "./run-write-authority.js";
import { LearningWriteAuthority } from "./learning-write-authority.js";
import { PostgresLearningScan } from "./learning-scan.js";
import { PostgresLearningEvidence } from "./learning-evidence.js";
import { PostgresLearningBudget } from "./learning-budget.js";
import { PostgresLearningCandidates } from "./learning-candidates.js";
import { PostgresLearningApplyBases } from "./learning-apply-bases.js";
import { PostgresLearningMaintenanceLedger } from "./learning-maintenance-ledger.js";
import { PostgresLearningChanges } from "./learning-changes.js";
import { PostgresLearningTaskOutcomes } from "./learning-task-outcomes.js";

type Callbacks = { onSettled?: (requestId: string) => void; onCommitted?: () => void };

export function createOwnedLearningRepositories(
  kernel: PostgresKernel,
  input: RunOwnerAuthority,
  callbacks: Callbacks = {},
) {
  return repositories(
    kernel,
    new LearningWriteAuthority(RunWriteAuthority.owned(input)),
    callbacks,
  );
}
export function createLegacyLearningRepositories(
  kernel: PostgresKernel,
  workerOwnership: AbortSignal,
  callbacks: Callbacks = {},
) {
  return repositories(
    kernel,
    new LearningWriteAuthority(RunWriteAuthority.legacy(workerOwnership)),
    callbacks,
  );
}
export function createFencedLegacyLearningRepositories(
  kernel: PostgresKernel,
  input: RunOwnerAuthority,
  callbacks: Callbacks = {},
) {
  return repositories(
    kernel,
    new LearningWriteAuthority(RunWriteAuthority.fencedLegacy(input)),
    callbacks,
  );
}
function repositories(
  kernel: PostgresKernel,
  authority: LearningWriteAuthority,
  callbacks: Callbacks,
) {
  return Object.freeze({
    scan: new PostgresLearningScan(kernel, authority),
    evidence: new PostgresLearningEvidence(kernel, authority),
    budget: new PostgresLearningBudget(kernel, authority),
    candidates: new PostgresLearningCandidates(kernel, authority),
    bases: new PostgresLearningApplyBases(kernel, authority),
    intents: new PostgresLearningMaintenanceLedger(kernel, authority, callbacks.onSettled),
    changes: new PostgresLearningChanges(kernel, authority, callbacks.onCommitted),
    outcomes: new PostgresLearningTaskOutcomes(kernel, authority),
  });
}
