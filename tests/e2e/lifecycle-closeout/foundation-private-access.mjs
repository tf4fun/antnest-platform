import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { inspect } from "node:util";
import { serviceClient } from "../../support/service-grants.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

function loopback(value, path = "/") {
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      url.pathname === path &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  );
  return path === "/" ? url.origin : url.href;
}
function fail(errors) {
  const all = [...new Set(errors)];
  if (all.length === 1) throw all[0];
  if (all.length)
    throw new AggregateError(all, "Foundation private resources failed");
}

export async function createFoundationPrivateAccess(
  config,
  {
    signal,
    secrets,
    collectTrace,
    watchFactory,
    telemetryFactory,
    traceDiagnostics,
    preserveWatch = (index, value) =>
      writeEvidenceFile(
        config.evidence,
        `private-watch-${index}.json`,
        JSON.stringify(value),
      ),
    preserveConnection = (index, value) =>
      writeEvidenceFile(
        config.evidence,
        `private-connection-${index}.json`,
        JSON.stringify(value),
      ),
    preserveState = (value) =>
      writeEvidenceFile(
        config.evidence,
        "private-state.json",
        JSON.stringify(value),
      ),
  } = {},
) {
  assert(Array.isArray(secrets));
  assert(collectTrace === undefined || typeof collectTrace === "function");
  assert(watchFactory === undefined || typeof watchFactory === "function");
  assert(
    telemetryFactory === undefined || typeof telemetryFactory === "function",
  );
  signal?.throwIfAborted();
  const privateAccess = config.privateAccess;
  assert(
    privateAccess &&
      typeof privateAccess.credentials === "string" &&
      privateAccess.credentials.startsWith("/"),
  );
  const acp = loopback(privateAccess.acp),
    identity = loopback(privateAccess.identity),
    otlp = loopback(privateAccess.otlp, "/v1/traces");
  // Private host consumers load the owning service's pinned dependencies.
  const dependencyRoot = new URL(
    "../../../services/agent-acp-service/package.json",
    import.meta.url,
  ).href;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "ws" ||
        specifier === "ajv/dist/2020.js" ||
        specifier.startsWith("@opentelemetry/") ||
        specifier === "@agentclientprotocol/sdk" ||
        specifier.startsWith("@agentclientprotocol/sdk/")
        ? next(specifier, { ...context, parentURL: dependencyRoot })
        : next(specifier, context);
    },
  });
  let modules;
  try {
    modules = await Promise.all([
      import("../identity-closeout/private-acp-telemetry.mjs"),
      import("../../support/private-acp-execution-state.mjs"),
      import("./foundation-connection.mjs"),
      import("./foundation-private-trace.mjs"),
    ]);
  } finally {
    hook.deregister();
  }
  const [
    { createPrivateACPTelemetry },
    { readPrivateExecutionState },
    { openFoundationConnection },
    { collectFoundationPrivateTrace },
  ] = modules;
  const paths = {
    "gateway-identity": "edge-gateway/tokens/identity-service",
    "agent-ui-acp": "agent-ui/tokens/agent-acp-service",
  };
  const service = serviceClient({
    identityEndpoint: identity,
    readCredential(grant) {
      assert(
        Object.hasOwn(paths, grant),
        "Foundation private grant is not allowed",
      );
      return readFileSync(
        join(privateAccess.credentials, paths[grant]),
        "utf8",
      );
    },
  });
  const telemetry = (telemetryFactory ?? createPrivateACPTelemetry)(otlp),
    clients = [],
    receipts = [],
    watches = [],
    openingWatches = new Set(),
    watchErrors = [],
    archiveErrors = [];
  let closing,
    index = 0,
    watchIndex = 0;
  const saveState = async () => {
    try {
      await preserveState(structuredClone(receipts));
    } catch (error) {
      archiveErrors.push(error);
      throw error;
    }
  };
  return {
    snapshots: () => clients.map((client) => client.snapshot()),
    stateReceipts: () => structuredClone(receipts),
    watchSnapshots: () =>
      watches
        .toSorted((a, b) => a.index - b.index)
        .map(({ watch }) => structuredClone(watch.snapshot())),
    watch(agentId, browser, principal) {
      assert(!closing, "Foundation private resources are closing");
      assert.equal(
        typeof watchFactory,
        "function",
        "private state watch owner required",
      );
      const index = ++watchIndex;
      const opening = Promise.resolve().then(async () => {
        try {
          const watch = await watchFactory(agentId, browser, {
            principal,
            service,
            telemetry,
            secrets,
            signal,
            endpoint: acp + "/rpc/agent-acp/watch-agent-execution-state",
            async preserve(value) {
              try {
                await preserveWatch(index, value);
              } catch (error) {
                archiveErrors.push(error);
                throw error;
              }
            },
          });
          watches.push({ index, watch });
          return watch;
        } catch (error) {
          watchErrors.push(error);
          throw error;
        }
      });
      openingWatches.add(opening);
      void opening.then(
        () => openingWatches.delete(opening),
        () => openingWatches.delete(opening),
      );
      return opening;
    },
    async open(agentId, browser, principal) {
      assert(!closing, "Foundation private resources are closing");
      const connection = ++index;
      const client = await openFoundationConnection(agentId, browser, {
        principal,
        service,
        telemetry,
        secrets,
        signal,
        endpoint: acp + "/v1/acp",
        preserve: (snapshot) => preserveConnection(connection, snapshot),
      });
      clients.push(client);
      return client;
    },
    async state(agentId, browser, principal) {
      assert(!closing, "Foundation private resources are closing");
      const errors = [];
      let state;
      try {
        state = await readPrivateExecutionState(agentId, browser, {
          principal,
          service,
          signal,
          secrets,
          receipts,
          endpoint: acp + "/rpc/agent-acp/get-agent-execution-state",
        });
      } catch (error) {
        errors.push(error);
      }
      try {
        await saveState();
      } catch (error) {
        errors.push(error);
      }
      if (signal?.aborted) errors.push(signal.reason);
      fail(errors);
      return state;
    },
    collect(expected, requests, collectorSignal = signal) {
      return (collectTrace ?? collectFoundationPrivateTrace)(
        config.jaeger,
        expected,
        {
          directory: config.evidence + "/traces",
          secrets,
          requests,
          signal: collectorSignal,
          flush: () => telemetry.flush(),
        },
      );
    },
    closeAndWait() {
      return (closing ??= (async () => {
        const errors = [];
        while (openingWatches.size)
          await Promise.allSettled([...openingWatches]);
        for (const { watch } of watches) {
          try {
            await watch.closeAndWait();
          } catch (error) {
            errors.push(error);
          }
        }
        for (const client of clients) {
          try {
            await client.closeAndWait();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await telemetry.shutdown();
        } catch (error) {
          console.warn(
            "Foundation telemetry shutdown failed; auxiliary diagnostics retained",
          );
          try {
            // Preserve the original failure even if the shared collection
            // budget is exhausted. Actual shutdown above is always joined.
            writeEvidenceFile(
              config.evidence,
              "foundation-telemetry-shutdown.private.txt",
              inspect(error, { depth: 8 }) + "\n",
            );
            const diagnostics =
              traceDiagnostics ??
              createTraceDiagnostics({ directory: config.evidence });
            await diagnostics.run("foundation-telemetry-shutdown", () => {
              throw error;
            });
          } catch {
            console.warn("Foundation telemetry diagnostic recording failed");
          }
        }
        try {
          await saveState();
        } catch (error) {
          errors.push(error);
        }
        errors.push(...watchErrors, ...archiveErrors);
        fail(errors);
      })());
    },
  };
}
