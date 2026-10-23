import { createRequire } from "node:module";
import type * as pg from "pg";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresRunRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import type {
  CreateRunIntentInput,
  RunIntent,
} from "../../../../services/agent-acp-service/src/ports/run-repository.js";

export type Command =
  | { kind: "start"; databaseUrl: string; applicationName: string }
  | {
      kind: "intent";
      commandId: string;
      input: Omit<CreateRunIntentInput, "createdAt"> & { createdAt: string };
    }
  | { kind: "stop" };

export type Reply =
  | { kind: "ready"; pid: number; backendPid: number }
  | { kind: "result"; commandId: string; ok: true; intent: RunIntent }
  | {
      kind: "result";
      commandId: string;
      ok: false;
      error: { name: string; code?: string; constraint?: string };
    }
  | { kind: "stopped"; pid: number; pending: 0 }
  | { kind: "fixture-error"; message: string };

const serviceRequire = createRequire(
  new URL(
    "../../../../services/agent-acp-service/package.json",
    import.meta.url,
  ),
);
const { Pool } = serviceRequire("pg") as typeof pg;
const BUDGET_MS = 5_000;
const pending = new Set<Promise<void>>();
const outbound = new Set<Promise<void>>();
let state: "new" | "starting" | "ready" | "stopping" | "stopped" = "new";
let pool: pg.Pool | undefined;
let repository: PostgresRunRepository | undefined;
let stopping: Promise<void> | undefined;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function command(value: unknown): value is Command {
  if (!record(value)) return false;
  if (value.kind === "stop") return true;
  if (value.kind === "start")
    return (
      typeof value.databaseUrl === "string" &&
      typeof value.applicationName === "string"
    );
  if (
    value.kind !== "intent" ||
    typeof value.commandId !== "string" ||
    !record(value.input)
  )
    return false;
  const input = value.input;
  for (const key of [
    "runId",
    "requestId",
    "sessionId",
    "expectedAccessRevision",
    "userMessageId",
    "createdAt",
  ])
    if (typeof input[key] !== "string") return false;
  if (
    !Array.isArray(input.prompt) ||
    !input.prompt.every(
      (block: unknown) => record(block) && typeof block.type === "string",
    )
  )
    return false;
  return (
    input.bridgeIntent === undefined ||
    (record(input.bridgeIntent) &&
      typeof input.bridgeIntent.intentId === "string" &&
      typeof input.bridgeIntent.expectedAppendVersion === "number")
  );
}

function ipcClosed(error: unknown): boolean {
  return (
    record(error) &&
    ["ERR_IPC_CHANNEL_CLOSED", "EPIPE"].includes(String(error.code))
  );
}

function send(reply: Reply): Promise<void> {
  if (!process.connected || process.send === undefined)
    return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sent = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Fixture IPC send exceeded its budget")),
      BUDGET_MS,
    );
    timer.unref();
    try {
      process.send!(reply, (error) => {
        if (error && !ipcClosed(error)) reject(error);
        else resolve();
      });
    } catch (error) {
      if (ipcClosed(error)) resolve();
      else
        reject(
          error instanceof Error
            ? error
            : new Error("Fixture IPC send failed", { cause: error }),
        );
    }
  }).finally(() => clearTimeout(timer));
  outbound.add(sent);
  const forget = () => outbound.delete(sent);
  void sent.then(forget, forget);
  return sent;
}

function describeError(error: unknown): {
  name: string;
  code?: string;
  constraint?: string;
} {
  const value = record(error) ? error : undefined;
  return {
    name: typeof value?.name === "string" ? value.name : "Error",
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
    ...(typeof value?.constraint === "string"
      ? { constraint: value.constraint }
      : {}),
  };
}

function disconnect(): void {
  if (!process.connected) return;
  try {
    process.disconnect?.();
  } catch (error) {
    if (!ipcClosed(error)) process.exitCode = 1;
  }
}

async function drain(operations: Set<Promise<void>>): Promise<void> {
  while (operations.size > 0) await Promise.allSettled([...operations]);
}

function stop(): Promise<void> {
  if (stopping !== undefined) return stopping;
  state = "stopping";
  clearTimeout(startup);
  stopping = (async () => {
    try {
      await drain(pending);
      // Closing this process must preserve every committed Run reservation.
      await pool?.end();
      await drain(outbound);
      state = "stopped";
      await send({ kind: "stopped", pid: process.pid, pending: 0 });
    } catch {
      process.exitCode = 1;
      await send({
        kind: "fixture-error",
        message: "Run intent fixture cleanup failed",
      }).catch(() => undefined);
    } finally {
      disconnect();
    }
  })();
  return stopping;
}

function fail(message: string): void {
  process.exitCode = 1;
  void send({ kind: "fixture-error", message }).catch(() => undefined);
  void stop();
}

function own(operation: () => Promise<void>): void {
  // Register the command before it can execute or yield, including startup.
  const running = Promise.resolve().then(operation);
  pending.add(running);
  void running.then(
    () => pending.delete(running),
    () => {
      pending.delete(running);
      fail("Run intent fixture operation failed");
    },
  );
}

function isStarting(): boolean {
  return state === "starting";
}

async function start(
  input: Extract<Command, { kind: "start" }>,
): Promise<void> {
  if (!isStarting()) return;
  const databaseUrl = new URL(input.databaseUrl);
  databaseUrl.searchParams.set("application_name", input.applicationName);
  pool = new Pool({
    connectionString: databaseUrl.href,
    application_name: input.applicationName,
    max: 1,
    connectionTimeoutMillis: BUDGET_MS,
    statement_timeout: BUDGET_MS,
    query_timeout: BUDGET_MS,
  });
  pool.on("error", () => fail("Run intent fixture Pool failed"));
  repository = new PostgresRunRepository(new PostgresKernel(pool));
  const result = await pool.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const backendPid = result.rows[0]?.pid;
  if (typeof backendPid !== "number")
    throw new Error("Fixture backend PID is unavailable");
  if (!isStarting()) return;
  state = "ready";
  await send({ kind: "ready", pid: process.pid, backendPid });
}

async function intent(
  input: Extract<Command, { kind: "intent" }>,
  current: PostgresRunRepository,
): Promise<void> {
  let reply: Reply;
  try {
    const createdAt = new Date(input.input.createdAt);
    if (!Number.isFinite(createdAt.getTime()))
      throw new TypeError("Invalid fixture timestamp");
    const accepted = await current.createRunIntent({
      ...input.input,
      createdAt,
    });
    reply = {
      kind: "result",
      commandId: input.commandId,
      ok: true,
      intent: accepted,
    };
  } catch (error) {
    reply = {
      kind: "result",
      commandId: input.commandId,
      ok: false,
      error: describeError(error),
    };
  }
  await send(reply);
}

const startup = setTimeout(
  () => fail("Run intent fixture did not receive start"),
  BUDGET_MS,
);
startup.unref();

process.on("SIGTERM", () => void stop());
process.on("disconnect", () => void stop());
process.on("message", (value: unknown) => {
  if (!command(value)) {
    fail("Invalid Run intent fixture command");
    return;
  }
  if (value.kind === "stop") {
    void stop();
    return;
  }
  if (value.kind === "start") {
    if (state !== "new") {
      fail("Run intent fixture may only start once");
      return;
    }
    state = "starting";
    clearTimeout(startup);
    own(() => start(value));
    return;
  }
  if (state !== "ready" || repository === undefined) {
    void send({
      kind: "result",
      commandId: value.commandId,
      ok: false,
      error: {
        name: "AbortError",
        code:
          state === "starting" || state === "new"
            ? "fixture_not_ready"
            : "fixture_stopping",
      },
    }).catch(() => fail("Run intent fixture reply failed"));
    return;
  }
  const current = repository;
  own(() => intent(value, current));
});
