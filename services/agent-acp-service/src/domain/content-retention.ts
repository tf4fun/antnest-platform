export type ContentRetentionConfig = Readonly<{
  deletedSessionRetentionMs: number;
  purgeBatch: number;
  purgeIntervalMs: number;
}>;

export type PurgeCounts = {
  sessions: number;
  runs: number;
  messages: number;
  toolAttempts: number;
  learningTasks: number;
  evidenceItems: number;
  evidenceSnapshots: number;
  candidates: number;
  publishedCandidates: number;
  learningChanges: number;
};

export type ContentPurgeRequest = {
  organizationId?: string;
  principalId?: string;
  sessionId?: string;
  cutoff?: Date;
  after?: string;
  limit: number;
  dryRun: boolean;
  waitForLocks?: boolean;
  signal: AbortSignal;
};

export type ContentPurgeBatch = {
  scanned: number;
  blocked: number;
  counts: PurgeCounts;
  nextCursor: string | null;
};

export type ContentPurger = {
  batch: (request: ContentPurgeRequest) => Promise<ContentPurgeBatch>;
};

export function emptyPurgeCounts(): PurgeCounts {
  return {
    sessions: 0,
    runs: 0,
    messages: 0,
    toolAttempts: 0,
    learningTasks: 0,
    evidenceItems: 0,
    evidenceSnapshots: 0,
    candidates: 0,
    publishedCandidates: 0,
    learningChanges: 0,
  };
}

const RETENTION_MAXIMUM_MS = 3650 * 24 * 60 * 60 * 1000;
const INTERVAL_MAXIMUM_MS = 60 * 60 * 1000;

function durationMs(value: string, name: string, minimum: number, maximum: number): number {
  const match = /^(\d+)(ms|s|m|h|d)$/u.exec(value);
  if (match === null) throw new Error(`${name} must be a duration using ms, s, m, h, or d`);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) throw new Error(`${name} must be a safe integer`);
  const multiplier =
    match[2] === "ms"
      ? 1
      : match[2] === "s"
        ? 1_000
        : match[2] === "m"
          ? 60_000
          : match[2] === "h"
            ? 3_600_000
            : 86_400_000;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms) || ms < minimum || ms > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return ms;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return parsed;
}

export function parseContentRetentionConfig(
  environment: Record<string, string | undefined>,
): ContentRetentionConfig {
  const retention = environment.ANTNEST_ACP_DELETED_SESSION_RETENTION ?? "30d";
  const deletedSessionRetentionMs =
    retention === "0"
      ? 0
      : durationMs(retention, "ANTNEST_ACP_DELETED_SESSION_RETENTION", 1, RETENTION_MAXIMUM_MS);
  const purgeBatch = integer(
    environment.ANTNEST_ACP_PURGE_BATCH ?? "500",
    "ANTNEST_ACP_PURGE_BATCH",
    1,
    500,
  );
  const purgeIntervalMs = durationMs(
    environment.ANTNEST_ACP_PURGE_INTERVAL ?? "60s",
    "ANTNEST_ACP_PURGE_INTERVAL",
    1,
    INTERVAL_MAXIMUM_MS,
  );
  return Object.freeze({ deletedSessionRetentionMs, purgeBatch, purgeIntervalMs });
}
