import { startAgentAcpService } from "./composition.js";
import { loadConfig } from "./config.js";
import { WorkerOwnershipLostError } from "./adapters/postgres/worker-lock.js";
import { startTelemetry } from "./telemetry/telemetry.js";
import { flushBeforeFailStop, raceWithOwnershipLoss, withShutdownDeadline } from "./shutdown.js";

const FAIL_STOP_TELEMETRY_TIMEOUT_MS = 500;

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetryRuntime = await startTelemetry(config.telemetry);
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
    const service = await raceWithOwnershipLoss(
      startAgentAcpService(config, telemetryRuntime.telemetry, (error) => {
        ownershipLoss.resolve(error);
      }),
      ownershipLoss.promise,
    );
    const outcome = await Promise.race([
      shutdownSignal().then((signal) => ({ kind: "signal" as const, signal })),
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
    telemetryRuntime.telemetry.log("error", "service_failed", {}, error);
    process.exitCode = 1;
  } finally {
    await withShutdownDeadline(shutdownTelemetry(), config.shutdownTimeoutMs, forceExit).catch(
      () => {
        process.exitCode = 1;
      },
    );
  }
}

function shutdownSignal(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
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
