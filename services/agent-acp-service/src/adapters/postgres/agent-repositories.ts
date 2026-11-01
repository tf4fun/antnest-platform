import type { PostgresKernel } from "./kernel.js";
import type { SecretBox } from "./secret-box.js";
import { PostgresSessionRepository } from "./session-repository.js";
import { PostgresSessionConfiguration } from "./session-configuration.js";
import { PostgresToolPermissions } from "./tool-permissions.js";
import { PostgresTemporarySkills } from "./temporary-skills.js";
import { PostgresContentPurge } from "./content-purge.js";
import { createBoundRunRepositories } from "./run-repositories.js";
import { RunWriteAuthority, type RunOwnerAuthority } from "./run-write-authority.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";

export function createOwnedAgentRepositories(
  kernel: PostgresKernel,
  box: SecretBox,
  input: RunOwnerAuthority,
  telemetry: TelemetryPort = NOOP_TELEMETRY,
) {
  return repositories(kernel, box, RunWriteAuthority.owned(input), telemetry);
}

export function createLegacyAgentRepositories(
  kernel: PostgresKernel,
  box: SecretBox,
  workerOwnership: AbortSignal,
  telemetry: TelemetryPort = NOOP_TELEMETRY,
) {
  return repositories(kernel, box, RunWriteAuthority.legacy(workerOwnership), telemetry);
}

export function createFencedLegacyAgentRepositories(
  kernel: PostgresKernel,
  box: SecretBox,
  input: RunOwnerAuthority,
  telemetry: TelemetryPort = NOOP_TELEMETRY,
) {
  return repositories(kernel, box, RunWriteAuthority.fencedLegacy(input), telemetry);
}

function repositories(
  kernel: PostgresKernel,
  box: SecretBox,
  authority: RunWriteAuthority,
  telemetry: TelemetryPort,
) {
  return Object.freeze({
    ...createBoundRunRepositories(kernel, authority),
    sessions: new PostgresSessionRepository(kernel, box, authority),
    sessionConfiguration: new PostgresSessionConfiguration(kernel, authority),
    permissions: new PostgresToolPermissions(kernel, authority),
    temporarySkills: new PostgresTemporarySkills(kernel, authority),
    contentPurge: new PostgresContentPurge(kernel, authority, telemetry),
  });
}
