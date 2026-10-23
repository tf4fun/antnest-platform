import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresWorkerLock } from "../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { testSecurityEnvironment } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const servicePackage = new URL(
  "../../../../services/agent-acp-service/package.json",
  import.meta.url,
);
const configurationQuery =
  "SELECT organization_id FROM execution_configurations ORDER BY organization_id";
const workerLockNumber = 2_026_083_002;
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Backend = { pid: number; backend_start: string };
type LogEvent = { event: string; error_type?: string };

// Guards report failures only. The fixture still releases its SQL lock and
// waits for the original child close, including after a SIGKILL fallback.
async function bounded<T>(
  original: Promise<T>,
  label: string,
  timeoutMs = 4000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      original,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(label + " did not finish")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function observe<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accepted(value)) return value;
    if (performance.now() >= deadline)
      throw new Error(label + " was not observed");
    await delay(20);
  }
}

async function reservePort(server: Server): Promise<number> {
  await bounded(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }),
    "port reservation",
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Port reservation has no TCP address");
  return address.port;
}

describe.skipIf(databaseUrl === undefined)(
  "real ACP main worker loss during startup recovery",
  () => {
    it.each(["release-before-deadline", "hold-through-deadline"] as const)(
      "%s retains the blocked original startup until it joins or the hard deadline terminates the process",
      async (mode) => {
        const identifier = randomUUID().replaceAll("-", "");
        const schema = "acp_main_worker_loss_" + identifier;
        const applicationName = "acp-main-worker-loss-" + identifier;
        const fixtureUrl = new URL(databaseUrl!);
        fixtureUrl.searchParams.set("options", "-c search_path=" + schema);
        fixtureUrl.searchParams.set(
          "application_name",
          applicationName + "-fixture",
        );
        const childUrl = new URL(fixtureUrl);
        childUrl.searchParams.set("application_name", applicationName);
        const pool = new Pool({
          connectionString: fixtureUrl.toString(),
          max: 3,
          connectionTimeoutMillis: 5000,
          statement_timeout: 10_000,
          query_timeout: 12_000,
        });
        const failures: unknown[] = [];
        const reservations: Server[] = [];
        const reservationCloses = new Map<Server, Promise<void>>();
        const exited = Promise.withResolvers<Exit>();
        const closed = Promise.withResolvers<Exit>();
        const workerLost = Promise.withResolvers<void>();
        const events: LogEvent[] = [];
        const environment = testSecurityEnvironment();
        const clientMcpKey = randomBytes(32).toString("base64");
        const sensitive = [
          clientMcpKey,
          ...readdirSync(environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR).map(
            (name) =>
              readFileSync(
                join(environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR, name),
                "utf8",
              ).trim(),
          ),
        ];
        let schemaCreated = false;
        let lock: PoolClient | undefined;
        let replacement: PostgresWorkerLock | undefined;
        let child: ChildProcess | undefined;
        let childExit: Exit | undefined;
        let childClose: Exit | undefined;
        let childError: Error | undefined;
        let exitedAt: number | undefined;
        let lossObservedAt: number | undefined;
        let stdout = "";
        let stderr = "";
        const childHasClosed = (): boolean => childClose !== undefined;
        const releaseTableLock = async (): Promise<void> => {
          const held = lock;
          if (held === undefined) return;
          lock = undefined;
          let discard = false;
          try {
            await held.query("ROLLBACK");
          } catch (error) {
            discard = true;
            throw error;
          } finally {
            held.release(discard);
          }
        };
        const releasePorts = async (): Promise<void> => {
          const results = await Promise.allSettled(
            reservations.map((server) => {
              let original = reservationCloses.get(server);
              if (original === undefined) {
                original = server.listening
                  ? new Promise<void>((resolve, reject) => {
                      server.close((error) =>
                        error === undefined ? resolve() : reject(error),
                      );
                    })
                  : Promise.resolve();
                reservationCloses.set(server, original);
              }
              return original;
            }),
          );
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
          );
          if (errors.length !== 0)
            throw new AggregateError(errors, "Port reservations did not close");
        };
        const childConnections = async (): Promise<number> =>
          (
            await pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity " +
                "WHERE datname=current_database() AND application_name=$1",
              [applicationName],
            )
          ).rows[0]!.count;
        const attempt = async (
          label: string,
          operation: () => Promise<unknown>,
        ): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            failures.push(new Error(label, { cause: error }));
          }
        };
        try {
          // This identifier is generated solely from a fixed prefix and UUID hex.
          await pool.query("CREATE SCHEMA " + schema);
          schemaCreated = true;
          await migrate(pool);
          lock = await pool.connect();
          const blockerPid = (
            await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]!.pid;
          await lock.query("BEGIN");
          await lock.query(
            "LOCK TABLE " +
              schema +
              ".execution_configurations IN ACCESS EXCLUSIVE MODE",
          );
          const ports: number[] = [];
          for (let index = 0; index < 2; index++) {
            const reservation = createServer();
            reservations.push(reservation);
            ports.push(await reservePort(reservation));
          }
          const childEnvironment: NodeJS.ProcessEnv = {
            ...process.env,
            ...environment,
            TSX_TSCONFIG_PATH: fileURLToPath(
              new URL(
                "../support/run-intent-child.tsconfig.json",
                import.meta.url,
              ),
            ),
            ANTNEST_ACP_DATABASE_URL: childUrl.toString(),
            ANTNEST_ACP_DATABASE_TIMEOUT: "10s",
            ANTNEST_ACP_CLIENT_MCP_KEY: clientMcpKey,
            ANTNEST_ACP_LISTEN: "127.0.0.1:" + ports[0]!,
            ANTNEST_ACP_CONTROL_LISTEN: "127.0.0.1:" + ports[1]!,
            ANTNEST_ACP_SHUTDOWN_TIMEOUT: "3s",
            OTEL_SDK_DISABLED: "true",
            OTEL_TRACES_EXPORTER: "none",
            OTEL_METRICS_EXPORTER: "none",
          };
          // The test exercises the legacy main path, without bootstrap or a loader shim.
          for (const name of [
            "NODE_OPTIONS",
            "ANTNEST_ACP_OWNER_MEMBER_ID",
            "ANTNEST_ACP_OWNER_LISTEN",
            "ANTNEST_ACP_RUNTIME_CONTROLLER_URL",
            "ANTNEST_ACP_OWNER_REGISTRATION_TIMEOUT",
          ])
            delete childEnvironment[name];
          await releasePorts();
          child = spawn(
            process.execPath,
            [
              "--import",
              createRequire(servicePackage).resolve("tsx"),
              fileURLToPath(new URL("./src/main.ts", servicePackage)),
            ],
            {
              cwd: fileURLToPath(new URL(".", servicePackage)),
              env: childEnvironment,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          // Install both receipts before waiting for any database or log observation.
          child.once("exit", (code, signal) => {
            childExit = { code, signal };
            exitedAt = performance.now();
            exited.resolve(childExit);
          });
          child.once("close", (code, signal) => {
            childClose = { code, signal };
            closed.resolve(childClose);
          });
          child.once("error", (error) => {
            childError = error;
          });
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            let newline: number;
            while ((newline = stdout.indexOf("\n")) !== -1) {
              const line = stdout.slice(0, newline);
              stdout = stdout.slice(newline + 1);
              let payload: unknown;
              try {
                payload = JSON.parse(line);
              } catch {
                continue;
              }
              if (payload === null || typeof payload !== "object") continue;
              const record = payload as Record<string, unknown>;
              if (typeof record.event !== "string") continue;
              events.push({
                event: record.event,
                ...(typeof record.error_type === "string"
                  ? { error_type: record.error_type }
                  : {}),
              });
              if (record.event === "worker_lock_lost") {
                lossObservedAt ??= performance.now();
                workerLost.resolve();
              }
            }
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-8192);
          });
          const blockedRows = await observe(
            async () => {
              if (childError !== undefined) throw childError;
              if (childExit !== undefined)
                throw new Error(
                  "ACP main exited before its configuration read blocked",
                );
              return (
                await pool.query<Backend>(
                  "SELECT a.pid,a.backend_start::text AS backend_start FROM pg_stat_activity a " +
                    "WHERE a.datname=current_database() AND a.application_name=$1 " +
                    "AND a.state='active' AND a.query=$2 AND a.wait_event_type='Lock' " +
                    "AND $3::int=ANY(pg_blocking_pids(a.pid))",
                  [applicationName, configurationQuery, blockerPid],
                )
              ).rows;
            },
            (rows) => rows.length === 1,
            "child configuration SELECT blocked by this fixture",
          );
          const originalRead = blockedRows[0]!;
          const workerRows = (
            await pool.query<Backend>(
              "SELECT a.pid,a.backend_start::text AS backend_start FROM pg_stat_activity a " +
                "JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() " +
                "AND a.application_name=$1 AND l.locktype='advisory' AND l.granted " +
                "AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) " +
                "AND l.classid=0::oid AND l.objid=$2::oid AND l.objsubid=1",
              [applicationName, workerLockNumber],
            )
          ).rows;
          expect(workerRows).toHaveLength(1);
          const worker = workerRows[0]!;
          expect(worker.pid).not.toBe(originalRead.pid);
          expect(worker.pid).not.toBe(blockerPid);
          const terminated = await pool.query<{ terminated: boolean }>(
            "SELECT pg_terminate_backend(a.pid) AS terminated FROM pg_stat_activity a " +
              "WHERE a.pid=$1 AND a.application_name=$2 AND a.backend_start=$3::timestamptz " +
              "AND a.datname=current_database() AND EXISTS(SELECT 1 FROM pg_locks l " +
              "WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted " +
              "AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) " +
              "AND l.classid=0::oid AND l.objid=$4::oid AND l.objsubid=1)",
            [
              worker.pid,
              applicationName,
              worker.backend_start,
              workerLockNumber,
            ],
          );
          expect(terminated.rows).toEqual([{ terminated: true }]);
          await bounded(
            Promise.race([
              workerLost.promise,
              closed.promise.then(() => {
                throw new Error(
                  "ACP main closed before reporting worker ownership loss",
                );
              }),
            ]),
            "actual worker_lock_lost log",
          );
          expect(child.kill("SIGTERM")).toBe(true);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(child.kill("SIGTERM")).toBe(true);
          // This explicit observation window must outlast the old 500ms fail-stop.
          // Completion is proved below by process receipts and actual SQL state.
          await delay(750);
          expect(childExit).toBeUndefined();
          expect(childClose).toBeUndefined();
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
          expect(
            (
              await pool.query<Backend>(
                "SELECT a.pid,a.backend_start::text AS backend_start FROM pg_stat_activity a " +
                  "WHERE a.pid=$1 AND a.backend_start=$2::timestamptz " +
                  "AND a.datname=current_database() AND a.application_name=$3 " +
                  "AND a.state='active' AND a.query=$4 AND a.wait_event_type='Lock' " +
                  "AND $5::int=ANY(pg_blocking_pids(a.pid))",
                [
                  originalRead.pid,
                  originalRead.backend_start,
                  applicationName,
                  configurationQuery,
                  blockerPid,
                ],
              )
            ).rows,
          ).toEqual([originalRead]);
          if (mode === "release-before-deadline") await releaseTableLock();
          const actualExit = await bounded(
            exited.promise,
            "original ACP main exit",
            5500,
          );
          const actualClose = await bounded(
            closed.promise,
            "original ACP main and pipes close",
          );
          expect(actualExit).toEqual({ code: 1, signal: null });
          expect(actualClose).toEqual(actualExit);
          expect(
            events.some((event) => event.event === "service_started"),
          ).toBe(false);
          if (mode === "release-before-deadline") {
            expect(events).toContainEqual({
              event: "service_failed",
              error_type: "WorkerOwnershipLostError",
            });
          } else {
            // The held SQL did not join normally. Only the hard deadline and
            // disappearance of the exited process's database resources are proved.
            expect(exitedAt! - lossObservedAt!).toBeGreaterThanOrEqual(1500);
            expect(exitedAt! - lossObservedAt!).toBeLessThan(5500);
          }
          await observe(
            childConnections,
            (count) => count === 0,
            "child database connections gone",
          );
          replacement = await PostgresWorkerLock.acquire(pool, {
            probeIntervalMs: 25,
          });
          expect(replacement.isHeld()).toBe(true);
          await replacement.release();
          replacement = undefined;
        } catch (error) {
          failures.push(error);
        } finally {
          // Independent cleanup always releases the blocker before stopping/joining
          // the child; neither an assertion nor a failed rollback skips later work.
          await attempt("fixture table lock release", releaseTableLock);
          await attempt("original child close", async () => {
            if (child === undefined) return;
            if (!childHasClosed()) {
              child.kill("SIGTERM");
              try {
                await bounded(
                  closed.promise,
                  "fixture child SIGTERM cleanup",
                  2000,
                );
              } catch (error) {
                failures.push(error);
                if (!childHasClosed()) child.kill("SIGKILL");
              }
            }
            await closed.promise;
          });
          await attempt("fixture port close", releasePorts);
          await attempt("replacement worker release", async () => {
            await replacement?.release();
          });
          if (schemaCreated) {
            await attempt(
              "remaining child database connection cleanup",
              async () => {
                await observe(
                  childConnections,
                  (count) => count === 0,
                  "all child backends gone",
                );
              },
            );
            await attempt("owned schema removal", () =>
              pool.query("DROP SCHEMA " + schema + " CASCADE"),
            );
          }
          await attempt("actual fixture Pool end", () => pool.end());
          try {
            expect(pool.totalCount).toBe(0);
            expect(pool.waitingCount).toBe(0);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length !== 0) {
          let diagnostic = stderr;
          for (const secret of sensitive)
            if (secret.length !== 0)
              diagnostic = diagnostic.split(secret).join("[redacted]");
          diagnostic = diagnostic
            .replace(/Bearer\s+[A-Za-z0-9_-]+/giu, "Bearer [redacted]")
            .replace(
              /postgres(?:ql)?:\/\/[^\s"']+/gu,
              "[redacted database URL]",
            );
          if (diagnostic.length !== 0)
            failures.push(
              new Error("ACP main stderr (redacted):\n" + diagnostic),
            );
          throw new AggregateError(
            failures,
            "Real ACP main worker-loss regression failed",
          );
        }
      },
      30_000,
    );
  },
);
