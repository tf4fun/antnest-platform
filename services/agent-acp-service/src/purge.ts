import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  parseContentPurgeArguments,
  runContentPurgeCommand,
} from "./application/content-purge-command.js";
import { PostgresContentPurge } from "./adapters/postgres/content-purge.js";
import { PostgresKernel, postgresPoolOptions } from "./adapters/postgres/kernel.js";
import { PostgresWorkerLock } from "./adapters/postgres/worker-lock.js";
import { RunWriteAuthority } from "./adapters/postgres/run-write-authority.js";
import { parseContentRetentionConfig } from "./domain/content-retention.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function databaseTimeoutMs(): number {
  const value = process.env.ANTNEST_ACP_DATABASE_TIMEOUT?.trim() ?? "10s";
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  if (match === null)
    throw new Error("ANTNEST_ACP_DATABASE_TIMEOUT must be a duration using ms, s, or m");
  const ms = Number(match[1]) * (match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 3_600_000)
    throw new Error("ANTNEST_ACP_DATABASE_TIMEOUT must be between 1 and 3600000");
  return ms;
}

export type ContentPurgeLock = {
  release: () => Promise<void>;
  waitForLoss: () => Promise<Error>;
};

export function isContentPurgeEntrypoint(filename: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && filename === resolve(argvPath);
}

export async function runOfflineContentPurge(input: {
  args: readonly string[];
  batchLimit: number;
  out: (line: string) => void;
  pool: Pool;
  ownership: AbortController;
  acquireLock?: (pool: Pool) => Promise<ContentPurgeLock>;
}): Promise<number> {
  const acquire =
    input.acquireLock ?? ((pool: Pool) => PostgresWorkerLock.acquire(pool, { mode: "exclusive" }));
  let lock: ContentPurgeLock | undefined;
  try {
    parseContentPurgeArguments(input.args);
    lock = await acquire(input.pool);
    void lock.waitForLoss().then((error) => input.ownership.abort(error));
    input.ownership.signal.throwIfAborted();
    const purge = new PostgresContentPurge(
      new PostgresKernel(input.pool),
      RunWriteAuthority.legacy(input.ownership.signal),
    );
    return await runContentPurgeCommand({
      args: input.args,
      purge,
      batchLimit: input.batchLimit,
      out: input.out,
      signal: input.ownership.signal,
    });
  } finally {
    try {
      await lock?.release();
    } finally {
      await input.pool.end();
    }
  }
}

async function main(): Promise<number> {
  parseContentPurgeArguments(process.argv.slice(2));
  const databaseUrl = requiredEnvironment("ANTNEST_ACP_DATABASE_URL");
  const retention = parseContentRetentionConfig(process.env);
  const pool = new Pool(postgresPoolOptions(databaseUrl, databaseTimeoutMs()));
  const ownership = new AbortController();
  const onSigint = () => ownership.abort(new Error("SIGINT"));
  const onSigterm = () => ownership.abort(new Error("SIGTERM"));
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await runOfflineContentPurge({
      args: process.argv.slice(2),
      batchLimit: retention.purgeBatch,
      out: (line) => process.stdout.write(`${line}\n`),
      pool,
      ownership,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (isContentPurgeEntrypoint(fileURLToPath(import.meta.url), process.argv[1]))
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const name = error instanceof Error ? error.name : "Error";
      process.stderr.write(`${JSON.stringify({ error: name })}\n`);
      process.exitCode = 1;
    },
  );
