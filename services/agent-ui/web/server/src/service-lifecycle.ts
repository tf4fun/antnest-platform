import { once } from "node:events";
import { createWorkspaceHttpServer } from "./http/node-server.ts";
import type { ServerResponse } from "node:http";
import type { BridgeTelemetry } from "./telemetry.ts";
import type { RequestAuthentication } from "./http/request-authentication.ts";

type WorkspaceRuntime = {
  handle(request: Request): Promise<Response | null>;
  sweep(): Promise<void>;
  drain(timeoutMs: number): Promise<{ forced: boolean }>;
};

export async function startWorkspaceService(input: {
  authentication: RequestAuthentication;
  runtime: WorkspaceRuntime;
  host: string;
  port: number;
  sweepIntervalMs?: number;
  drainTimeoutMs?: number;
  onSweepError?(error: unknown): void;
  onForcedDrain?(): void;
  telemetry?: Pick<BridgeTelemetry, "observeHttp">;
  document?: {
    assetRoot: string;
    renderDocument(output: ServerResponse, input: {
      bootstrap?: unknown;
      route: { agentId: string; sessionId: string | null };
      nonce: string;
    }): Promise<void>;
  };
}): Promise<{ port: number; close(): Promise<void> }> {
  const intervalMs = input.sweepIntervalMs ?? 30_000;
  const drainTimeoutMs = input.drainTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
    throw new RangeError("Invalid Bridge sweep interval");
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0)
    throw new RangeError("Invalid Bridge drain timeout");
  let draining = false;
  const server = createWorkspaceHttpServer(input.runtime, {
    authentication: input.authentication,
    ...input.document,
    isDraining: () => draining,
    telemetry: input.telemetry,
  });
  server.listen(input.port, input.host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Bridge service has no TCP address");
  let sweeping: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (sweeping !== null) return;
    sweeping = input.runtime
      .sweep()
      .catch((error: unknown) => input.onSweepError?.(error))
      .then(() => {
        sweeping = null;
      });
  }, intervalMs);
  timer.unref();
  let closing: Promise<void> | null = null;
  return {
    port: address.port,
    close() {
      if (closing !== null) return closing;
      draining = true;
      closing = (async () => {
        clearInterval(timer);
        try {
          const result = await input.runtime.drain(drainTimeoutMs);
          if (result.forced) input.onForcedDrain?.();
        } finally {
          const serverClosed = new Promise<void>((resolve, reject) => {
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          });
          server.closeAllConnections();
          await serverClosed;
          await sweeping;
        }
      })();
      return closing;
    },
  };
}
