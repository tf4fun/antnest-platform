import { loadConfig } from "./config.js";
import { WorkerOwnershipLostError } from "./adapters/postgres/worker-lock.js";
import { startTelemetry } from "./telemetry/telemetry.js";
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
  const stopping = shutdownSignal(startupController);
  const ownershipLoss = Promise.withResolvers<WorkerOwnershipLostError>();
  let telemetryShutdown: Promise<void> | undefined;
  const shutdownTelemetry = (): Promise<void> => {
    telemetryShutdown ??= telemetryRuntime.shutdown();
    return telemetryShutdown;
  };
  const failStop = async (): Promise<never> => {
    await flushBeforeFailStop(shutdownTelemetry(), FAIL_STOP_TELEMETRY_TIMEOUT_MS);
    return forceExit();
  };
  try {
    // The driver must load after its standard instrumentation is registered.
    const { startAgentAcpService } = await import("./composition.js");
    const startup = raceWithOwnershipLoss(
      startAgentAcpService(
        config,
        telemetryRuntime.telemetry,
        (error) => ownershipLoss.resolve(error),
        startupController.signal,
      ),
      ownershipLoss.promise,
    );
    const started = await Promise.race([
      startup.then((service) => ({ kind: "started" as const, service })),
      stopping.signal.then((signal) => ({ kind: "signal" as const, signal })),
    ]);
    if (started.kind === "signal") {
      telemetryRuntime.telemetry.log("info", "shutdown_requested", { signal: started.signal });
      // Keep the original startup task owned until cancellation and cleanup
      // finish, including the case where startup won the race to return.
      await raceWithOwnershipLoss(
        withShutdownDeadline(
          startup.then(
            (service) => service.shutdown(),
            (error: unknown) => {
              if (!isShutdownReason(error)) throw error;
            },
          ),
          config.shutdownTimeoutMs,
          forceExit,
        ),
        ownershipLoss.promise,
      );
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
      if (outcome.error instanceof WorkerOwnershipLostError) {
        await failStop();
      }
      await raceWithOwnershipLoss(
        withShutdownDeadline(service.shutdown(), config.shutdownTimeoutMs, forceExit),
        ownershipLoss.promise,
      );
      throw new Error("Agent ACP Service requires process replacement", {
        cause: outcome.error,
      });
    }
    telemetryRuntime.telemetry.log("info", "shutdown_requested", { signal: outcome.signal });
    await raceWithOwnershipLoss(
      withShutdownDeadline(service.shutdown(), config.shutdownTimeoutMs, forceExit),
      ownershipLoss.promise,
    );
  } catch (error) {
    if (error instanceof WorkerOwnershipLostError) {
      await failStop();
    }
    if (!isShutdownReason(error)) {
      telemetryRuntime.telemetry.log("error", "service_failed", {}, error);
      process.exitCode = 1;
    }
  } finally {
    stopping.dispose();
    await withShutdownDeadline(shutdownTelemetry(), config.shutdownTimeoutMs, forceExit).catch(
      () => {
        process.exitCode = 1;
      },
    );
  }
}

function shutdownSignal(startup: AbortController): {
  signal: Promise<"SIGINT" | "SIGTERM">;
  dispose(): void;
} {
  const signal = Promise.withResolvers<"SIGINT" | "SIGTERM">();
  const stop = (name: "SIGINT" | "SIGTERM"): void => {
    signal.resolve(name);
    startup.abort(createShutdownReason());
  };
  const interrupt = (): void => stop("SIGINT");
  const terminate = (): void => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
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
