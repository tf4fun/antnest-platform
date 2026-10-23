import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunningAgentAcpService } from "../src/composition.js";

const dependencies = vi.hoisted(() => ({
  start: vi.fn(),
  log: vi.fn(),
  telemetryShutdown: vi.fn<() => Promise<void>>(),
}));
vi.mock("../src/config.js", () => ({ loadConfig: () => ({ shutdownTimeoutMs: 2000 }) }));
vi.mock("../src/telemetry/telemetry.js", () => ({
  startTelemetry: () =>
    Promise.resolve({
      telemetry: { log: dependencies.log },
      shutdown: dependencies.telemetryShutdown,
    }),
}));
vi.mock("../src/composition.js", () => ({ startAgentAcpService: dependencies.start }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("main owns original tasks after worker ownership loss", () => {
  it.each([
    "startup-reject",
    "startup-return",
    "startup-late-failure",
    "serving",
    "shutdown",
    "shutdown-late-failure",
  ] as const)("joins the original %s task before telemetry and exit", async (phase) => {
    vi.resetModules();
    dependencies.log.mockReset();
    dependencies.telemetryShutdown.mockReset().mockResolvedValue();
    const { WorkerOwnershipLostError } = await import("../src/adapters/postgres/worker-lock.js");
    const loss = new WorkerOwnershipLostError();
    const lateFailure = new Error("original task failed during cleanup");
    const startupHeld = phase.startsWith("startup-");
    const startup = Promise.withResolvers<RunningAgentAcpService>();
    const shutdown = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    const started = Promise.withResolvers<void>();
    const shutdownEntered = Promise.withResolvers<void>();
    let reportLoss: ((error: Error) => void) | undefined;
    let startupSignal: AbortSignal | undefined;
    const stop = vi.fn(() => {
      shutdownEntered.resolve();
      return shutdown.promise;
    });
    const service: RunningAgentAcpService = {
      failure: failure.promise,
      shutdown: stop,
      address: () => null,
      controlAddress: () => null,
    };
    dependencies.start.mockReset().mockImplementation((_config, _telemetry, report, signal) => {
      reportLoss = report as (error: Error) => void;
      startupSignal = signal as AbortSignal;
      started.resolve();
      return startup.promise;
    });
    const originalExitCode = process.exitCode;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const listeners = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    const main = import("../src/main.js");
    try {
      await started.promise;
      if (!startupHeld) {
        startup.resolve(service);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (phase.startsWith("shutdown")) {
        process.emit("SIGTERM");
        await shutdownEntered.promise;
      }
      reportLoss!(loss);
      failure.resolve(loss);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        exit,
        "loss must not skip the original task and resource cleanup",
      ).not.toHaveBeenCalled();
      expect(dependencies.telemetryShutdown).not.toHaveBeenCalled();
      if (startupHeld) {
        expect(startupSignal?.aborted, "startup admission closes immediately").toBe(true);
        if (phase === "startup-reject") startup.reject(loss);
        else if (phase === "startup-late-failure") startup.reject(lateFailure);
        else {
          startup.resolve(service);
          await shutdownEntered.promise;
        }
      } else {
        await shutdownEntered.promise;
      }
      if (phase !== "startup-reject" && phase !== "startup-late-failure") {
        expect(stop).toHaveBeenCalledOnce();
        expect(dependencies.telemetryShutdown).not.toHaveBeenCalled();
      }
      if (phase === "shutdown-late-failure") shutdown.reject(lateFailure);
      else shutdown.resolve();
      await main;
      expect(dependencies.telemetryShutdown).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      const logged = dependencies.log.mock.calls.find(
        (call) => call[1] === "service_failed",
      )?.[3] as unknown;
      if (phase.endsWith("late-failure")) {
        expect(logged).toBeInstanceOf(AggregateError);
        expect((logged as AggregateError).errors).toEqual([loss, lateFailure]);
      } else expect(logged).toBe(loss);
      expect(dependencies.log.mock.invocationCallOrder.at(-1)).toBeLessThan(
        dependencies.telemetryShutdown.mock.invocationCallOrder[0]!,
      );
      expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(
        listeners,
      );
    } finally {
      startup.resolve(service);
      shutdown.resolve();
      failure.resolve(loss);
      reportLoss?.(loss);
      await main;
      process.exitCode = originalExitCode;
    }
  });

  it("keeps the original shutdown deadline when loss arrives during cleanup", async () => {
    vi.resetModules();
    dependencies.log.mockReset();
    dependencies.telemetryShutdown.mockReset().mockResolvedValue();
    const { WorkerOwnershipLostError } = await import("../src/adapters/postgres/worker-lock.js");
    const loss = new WorkerOwnershipLostError();
    const started = Promise.withResolvers<void>();
    const shutdownEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalJoined = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    let reportLoss: ((error: Error) => void) | undefined;
    const shutdown = vi.fn(async () => {
      shutdownEntered.resolve();
      await release.promise;
      originalJoined.resolve();
    });
    dependencies.start.mockReset().mockImplementation((_config, _telemetry, report) => {
      reportLoss = report as (error: Error) => void;
      started.resolve();
      return Promise.resolve({ failure: failure.promise, shutdown });
    });
    const originalExitCode = process.exitCode;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const main = import("../src/main.js");
    try {
      await started.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      process.emit("SIGTERM");
      await shutdownEntered.promise;
      await vi.advanceTimersByTimeAsync(1500);
      reportLoss!(loss);
      await vi.advanceTimersByTimeAsync(499);
      expect(exit).not.toHaveBeenCalled();
      expect(dependencies.telemetryShutdown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await main;
      expect(exit).toHaveBeenCalledWith(1);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(dependencies.telemetryShutdown).not.toHaveBeenCalled();
      // The real callback terminates the process. This intercepted callback
      // proves only the hard deadline, never successful task quiescence.
    } finally {
      release.resolve();
      await originalJoined.promise;
      await main;
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.exitCode = originalExitCode;
    }
  });

  it.each(["serving", "startup-return"] as const)(
    "retains a failure notification after SIGTERM in %s",
    async (phase) => {
      vi.resetModules();
      dependencies.log.mockReset();
      dependencies.telemetryShutdown.mockReset().mockResolvedValue();
      const notification = new Error("background task failed while closing");
      const startup = Promise.withResolvers<RunningAgentAcpService>();
      const started = Promise.withResolvers<void>();
      const failure = Promise.withResolvers<Error>();
      const shutdownEntered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const shutdown = vi.fn(() => {
        shutdownEntered.resolve();
        return release.promise;
      });
      const service: RunningAgentAcpService = {
        failure: failure.promise,
        shutdown,
        address: () => null,
        controlAddress: () => null,
      };
      dependencies.start.mockReset().mockImplementation(() => {
        started.resolve();
        return startup.promise;
      });
      const originalExitCode = process.exitCode;
      process.exitCode = undefined;
      const main = import("../src/main.js");
      try {
        await started.promise;
        if (phase === "serving") {
          startup.resolve(service);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        process.emit("SIGTERM");
        if (phase === "startup-return") {
          failure.resolve(notification);
          startup.resolve(service);
        }
        await shutdownEntered.promise;
        failure.resolve(notification);
        await new Promise<void>((resolve) => setImmediate(resolve));
        release.resolve();
        await main;
        expect(process.exitCode).toBe(1);
        expect(dependencies.log).toHaveBeenCalledWith("error", "service_failed", {}, notification);
        expect(shutdown).toHaveBeenCalledOnce();
      } finally {
        startup.resolve(service);
        release.resolve();
        failure.resolve(notification);
        await main;
        process.exitCode = originalExitCode;
      }
    },
  );

  it.each([false, true])(
    "retains telemetry failure as a warning after cleanup (loss=%s)",
    async (ownershipLost) => {
      vi.resetModules();
      dependencies.log.mockReset();
      const diagnostic = new Error("telemetry exporter unavailable");
      dependencies.telemetryShutdown.mockReset().mockRejectedValue(diagnostic);
      const { WorkerOwnershipLostError } = await import("../src/adapters/postgres/worker-lock.js");
      const loss = new WorkerOwnershipLostError();
      const started = Promise.withResolvers<void>();
      const failure = Promise.withResolvers<Error>();
      let reportLoss: ((error: Error) => void) | undefined;
      const shutdown = vi.fn(() => Promise.resolve());
      dependencies.start.mockReset().mockImplementation((_config, _telemetry, report) => {
        reportLoss = report as (error: Error) => void;
        started.resolve();
        return Promise.resolve({ failure: failure.promise, shutdown });
      });
      const originalExitCode = process.exitCode;
      process.exitCode = undefined;
      const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const main = import("../src/main.js");
      try {
        await started.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (ownershipLost) reportLoss!(loss);
        else process.emit("SIGTERM");
        await main;
        expect(shutdown).toHaveBeenCalledOnce();
        expect(dependencies.log).toHaveBeenCalledWith(
          "warn",
          "telemetry_shutdown_failed",
          {},
          diagnostic,
        );
        expect(process.exitCode).toBe(ownershipLost ? 1 : undefined);
        if (ownershipLost) expect(exit).toHaveBeenCalledWith(1);
        else expect(exit).not.toHaveBeenCalled();
      } finally {
        await main;
        process.exitCode = originalExitCode;
      }
    },
  );
});
