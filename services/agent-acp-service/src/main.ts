import { loadConfig } from "./config.js";
import { WorkerOwnershipLostError } from "./adapters/postgres/worker-lock.js";
import { startTelemetry } from "./telemetry/telemetry.js";
import type { RunningAgentAcpService } from "./composition.js";
import {
  createShutdownReason,
  isShutdownReason,
  flushBeforeFailStop,
  raceWithOwnershipLoss,
  withShutdownDeadline,
} from "./shutdown.js";

const FAIL_STOP_TELEMETRY_TIMEOUT_MS = 500;

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetryRuntime = await startTelemetry(config.telemetry);
  const startupController = new AbortController();
  let deadline: number | undefined;
  const stop = (reason: Error): void => {
    deadline ??= performance.now() + config.shutdownTimeoutMs;
    startupController.abort(reason);
  };
  const stopping = shutdownSignal(stop);
  const ownershipLoss = Promise.withResolvers<WorkerOwnershipLostError>();
  let lost: WorkerOwnershipLostError | undefined;
  let startup: Promise<RunningAgentAcpService> | undefined;
  let observingFailures = true;
  const failures: unknown[] = [];
  const rememberFailure = (error: unknown): void => {
    if (!isShutdownReason(error) && !failures.includes(error)) failures.push(error);
  };
  const observeFailure = (error: unknown): void => {
    if (!observingFailures) return;
    if (error instanceof WorkerOwnershipLostError) {
      lost ??= error;
      ownershipLoss.resolve(error);
    }
    rememberFailure(error);
    stop(error instanceof Error ? error : new Error("Agent ACP Service failed", { cause: error }));
  };
  let reportedFailures = 0;
  const reportFailures = (): void => {
    if (failures.length <= reportedFailures) return;
    process.exitCode = 1;
    const error =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Agent ACP Service stopped with failures");
    telemetryRuntime.telemetry.log("error", "service_failed", {}, error);
    reportedFailures = failures.length;
  };
  let telemetryShutdown: Promise<void> | undefined;
  const shutdownTelemetry = (): Promise<void> => {
    telemetryShutdown ??= telemetryRuntime.shutdown();
    return telemetryShutdown;
  };
  try {
    // The driver must load after its standard instrumentation is registered.
    const { startAgentAcpService } = await import("./composition.js");
    startup = startAgentAcpService(
      config,
      telemetryRuntime.telemetry,
      observeFailure,
      startupController.signal,
    );
    // Notifications remain authoritative while startup or shutdown is pending,
    // even if SIGTERM already won the control-flow race.
    void startup.then(
      (service) => {
        void service.failure.then(observeFailure, observeFailure);
      },
      () => undefined,
    );
    const started = await Promise.race([
      startup.then((service) => ({ kind: "started" as const, service })),
      stopping.signal.then((signal) => ({ kind: "signal" as const, signal })),
      ownershipLoss.promise.then((error) => Promise.reject(error)),
    ]);
    if (started.kind === "signal") {
      telemetryRuntime.telemetry.log("info", "shutdown_requested", { signal: started.signal });
      return;
    }
    const service = started.service;
    const outcome = await Promise.race([
      stopping.signal.then((signal) => ({ kind: "signal" as const, signal })),
      service.failure.then((error) => ({ kind: "failure" as const, error })),
      ownershipLoss.promise.then((error) => ({ kind: "ownership_loss" as const, error })),
    ]);
    if (outcome.kind === "ownership_loss") {
      throw outcome.error;
    }
    if (outcome.kind === "failure") {
      throw outcome.error;
    }
    telemetryRuntime.telemetry.log("info", "shutdown_requested", { signal: outcome.signal });
  } catch (error) {
    rememberFailure(error);
    stop(error instanceof Error ? error : new Error("Agent ACP Service failed", { cause: error }));
  } finally {
    stop(createShutdownReason());
    // Loss closes admission immediately. It must not replace the original
    // startup/shutdown promise: that task still owns SQL, Runtime and cleanup.
    // All phases share the deadline established by the first stop request.
    await withShutdownDeadline(
      (async () => {
        try {
          const service = await startup;
          await service?.shutdown();
        } catch (error) {
          rememberFailure(error);
        }
        observingFailures = false;
        reportFailures();
        const originalTelemetryShutdown = shutdownTelemetry().catch((error: unknown) => {
          telemetryRuntime.telemetry.log("warn", "telemetry_shutdown_failed", {}, error);
        });
        try {
          await raceWithOwnershipLoss(originalTelemetryShutdown, ownershipLoss.promise);
        } catch (error) {
          if (lost === undefined) rememberFailure(error);
          else await flushBeforeFailStop(originalTelemetryShutdown, FAIL_STOP_TELEMETRY_TIMEOUT_MS);
        }
      })(),
      Math.max(0, deadline! - performance.now()),
      forceExit,
    ).catch(rememberFailure);
    reportFailures();
    stopping.dispose();
    if (lost !== undefined) forceExit();
  }
}

function shutdownSignal(requestStop: (reason: Error) => void): {
  signal: Promise<"SIGINT" | "SIGTERM">;
  dispose(): void;
} {
  const signal = Promise.withResolvers<"SIGINT" | "SIGTERM">();
  const stop = (name: "SIGINT" | "SIGTERM"): void => {
    signal.resolve(name);
    requestStop(createShutdownReason());
  };
  const interrupt = (): void => stop("SIGINT");
  const terminate = (): void => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return {
    signal: signal.promise,
    dispose() {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    },
  };
}

function forceExit(): never {
  process.exit(1);
}

await main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : typeof error;
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "bootstrap_failed",
      service: "agent-acp-service",
      error_type: errorType,
    })}\n`,
  );
  process.exitCode = 1;
});
