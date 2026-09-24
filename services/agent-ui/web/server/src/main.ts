import { AcpHttpBridge } from "./adapters/acp-http.ts";
import { discoverWorkspaceAgents } from "./adapters/controller-workspace.ts";
import { parseServiceConfig } from "./service-config.ts";
import { startWorkspaceService } from "./service-lifecycle.ts";
import { createWorkspaceRuntime } from "./workspace-runtime.ts";
import { loadWorkspaceDocument } from "./ssr-assets.ts";
import { startBridgeTelemetry } from "./telemetry.ts";

const config = parseServiceConfig(process.env);
const telemetry = await startBridgeTelemetry(config.telemetry);
const runtime = createWorkspaceRuntime({
  maxSessionHistoryBytes: config.maxSessionHistoryBytes,
  maxGlobalHistoryBytes: config.maxGlobalHistoryBytes,
  maxCachedHistoryBytes: config.maxCachedHistoryBytes,
  maxOwners: config.maxOwners,
  recordColdReplay: telemetry.recordColdReplay,
  recordLocalIntentReuse: telemetry.recordLocalIntentReuse,
  maxAcpPromptBytes: config.maxAcpPromptBytes,
  idleMs: config.idleMs,
  discover: config.controllerBaseUrl === undefined
    ? undefined
    : (scope) => discoverWorkspaceAgents({
        baseUrl: config.controllerBaseUrl!,
        scope,
      }),
  connect: (scope, callbacks) =>
    AcpHttpBridge.open({
      baseUrl: config.acpBaseUrl,
      scope,
      callbacks,
    }),
});
telemetry.registerRuntimeMetrics(runtime.metrics);
let service: Awaited<ReturnType<typeof startWorkspaceService>>;
try {
  service = await startWorkspaceService({
    runtime,
    document: await loadWorkspaceDocument(),
    host: config.host,
    port: config.port,
    sweepIntervalMs: config.sweepIntervalMs,
    telemetry,
    onSweepError: (error) => console.error("Bridge owner sweep failed", error),
    onForcedDrain: () => console.warn("Bridge drain did not close cleanly"),
  });
} catch (error) {
  await telemetry.shutdown();
  throw error;
}
console.info(`Agent UI Bridge listening on ${config.host}:${service.port}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      let failed = false;
      try { await service.close(); }
      catch (error) { console.error("Bridge shutdown failed", error); failed = true; }
      try { await telemetry.shutdown(); }
      catch (error) { console.error("Bridge telemetry shutdown failed", error); failed = true; }
      process.exit(failed ? 1 : 0);
    })();
  });
}
