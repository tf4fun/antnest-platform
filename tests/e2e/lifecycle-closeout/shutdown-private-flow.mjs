import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { createFoundationPrivateAccess } from "./foundation-private-access.mjs";
import { openShutdownPrivateWatch } from "./shutdown-private-watch.mjs";
import {
  openShutdownWatch,
  openShutdownWatchSet,
} from "./shutdown-streams.mjs";
import {
  collectShutdownTrace,
  assertIdleMaintenance,
  assertReadyExecutionState,
} from "./shutdown-evidence.mjs";
import { collectPrivateShutdownTrace } from "./shutdown-private-trace.mjs";
import { flushTraceProducers } from "./network-support.mjs";
import {
  readRestoreTransport,
  assertRestoreTransportContinuity,
} from "./restore-private-transport.mjs";
import {
  assertRestoreOwner,
  closeRestoreConnections,
  collectRestoreTraces,
} from "./restore-private-session.mjs";

export function recordShutdownFailures(result, errors) {
  if (!Object.hasOwn(result, "shutdownErrors"))
    Object.defineProperty(result, "shutdownErrors", { value: [] });
  result.shutdownErrors.push(...errors);
  result.private_collection_errors = [...new Set(result.shutdownErrors)].map(
    (error) => inspect(error, { depth: 8 }),
  );
  return result;
}
export function shutdownFailures(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Shutdown business, evidence or cleanup failed",
    );
}
const digest = (owner) => {
  assert(
    typeof owner.accessToken === "string" && owner.accessToken,
    "original Shutdown Session missing",
  );
  return createHash("sha256").update(owner.accessToken).digest("hex");
};

export async function runPrivateShutdown(input, scenario, overrides = {}) {
  const { config, signal, traceSecrets } = input;
  const dependencies = {
    createAccess: createFoundationPrivateAccess,
    openPublic: openShutdownWatch,
    collectPublic: (expected, localSignal = signal) =>
      collectShutdownTrace(config.jaeger, expected, traceSecrets, {
        directory: config.evidence + "/traces",
        signal: localSignal,
      }),
    preservePublic: (index, value) =>
      writeEvidenceFile(
        config.evidence,
        `shutdown-public-watch-${index}.json`,
        JSON.stringify(value),
      ),
    preserveFailure: (row, error, index) =>
      writeEvidenceFile(
        config.evidence,
        `shutdown-trace-failure-${index}.txt`,
        inspect({ expected: row, error }, { depth: 8 }),
      ),
    readTransport: () => readRestoreTransport(config, input.docker),
    flush: (localSignal) =>
      flushTraceProducers(config, input.docker, localSignal),
    async readModel() {
      const response = await fetch(config.model + "/status", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    ...overrides,
  };
  const work = {
    creation_principal: input.principal,
    logins: [],
    delegations: [],
    states: [],
    histories: [],
    idle: [],
    public_watches: [],
    platform_inventory: {},
    lifecycle_admissions: [],
  };
  const clients = [],
    watches = [],
    publicWatches = [],
    privateWatches = [],
    errors = [];
  let access,
    business = {},
    watchTraces = [],
    requestTraces = [],
    collectedWatches = false,
    failedRequests = 0,
    exporterClosed = false;
  const bind = (agentID, owner, principal) => {
    assert.equal(work.logins.length, 1, "one original Shutdown login required");
    const login = work.logins[0];
    assert.equal(
      digest(owner),
      login.session_digest,
      "Shutdown replaced the original Session",
    );
    assert.deepEqual(principal, login.principal);
    assertRestoreOwner(
      principal,
      work.creation_principal,
      work.states[0].agent,
      agentID,
    );
    return {
      session_digest: login.session_digest,
      principal: structuredClone(principal),
    };
  };
  async function closeWatches() {
    for (const watch of watches) {
      try {
        watch.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const watch of watches) {
      const publicIndex = publicWatches.indexOf(watch);
      let joined = false;
      try {
        await watch.closeAndWait();
        joined = true;
      } catch (error) {
        errors.push(error);
      }
      if (publicIndex >= 0) {
        const value = {
          traceID: watch.traceID,
          events: structuredClone(watch.events),
          closure: structuredClone(watch.closure),
          transport_diagnostics: structuredClone(
            watch.transportDiagnostics ?? [],
          ),
          joined,
        };
        work.public_watches[publicIndex] = value;
        try {
          await dependencies.preservePublic(publicIndex + 1, value);
        } catch (error) {
          errors.push(error);
        }
      }
    }
  }
  async function collectWatches() {
    if (collectedWatches || signal?.aborted) return;
    const common = {
      agentID: work.states[0]?.agent.agent_id,
      stop: work.stop,
      stopWindow: work.stop_window,
    };
    const rows = [];
    const event = publicWatches[0];
    if (event)
      rows.push({
        ...common,
        kind: "event_watch",
        traceID: event.traceID,
        route: "/api/admin/{path...}",
        console: true,
        controllerRoute: "/internal/agents/{agent_id}/events/watch",
        closure: event.closure,
      });
    const state = privateWatches[0]?.snapshot();
    if (state)
      rows.push({
        ...common,
        kind: "private_state_watch",
        traceID: state.traceID,
        clientSpanID: state.clientSpanID,
        principal: work.logins[0]?.principal,
        session_digest: work.logins[0]?.session_digest,
        receipt: state,
        closure: state.closure,
      });
    watchTraces = await collectRestoreTraces(
      rows,
      (row, localSignal = signal) =>
        row.kind === "event_watch"
          ? dependencies.collectPublic(row, localSignal)
          : access.collect(row, [], localSignal),
      (row, error) =>
        dependencies.preserveFailure(row, error, ++failedRequests),
      signal,
      errors,
      input.traceDiagnostics,
    );
    collectedWatches = true;
  }
  const adapter = {
    login(owner, response) {
      assert.equal(
        work.logins.length,
        0,
        "Shutdown must reuse its original login",
      );
      assert.equal(response.status, 200);
      assert.match(response.traceID, /^[a-f0-9]{32}$/u);
      const principal = response.body.principal;
      assertRestoreOwner(
        principal,
        work.creation_principal,
        work.states[0].agent,
        work.states[0].agent.agent_id,
      );
      work.logins.push({
        status: response.status,
        trace_id: response.traceID,
        principal: structuredClone(principal),
        session_digest: digest(owner),
      });
      return structuredClone(principal);
    },
    async open(agentID, owner, principal) {
      const binding = bind(agentID, owner, principal);
      const client = await access.open(agentID, owner, principal);
      clients.push(client);
      work.delegations.push({
        ...binding,
        kind: "acp",
        trace_id: client.connectionTraceID,
      });
      return client;
    },
    async watchPair(admin, owner, principal, agentID) {
      const binding = bind(agentID, owner, principal);
      const pair = await openShutdownWatchSet(
        [["public"], ["private"]],
        async (kind) => {
          let watch;
          if (kind === "public") {
            watch = dependencies.openPublic(
              admin,
              `/api/admin/agents/${agentID}/events/watch`,
              "agent_event",
              (event) => assert.equal(event.agent_id, agentID),
              signal,
            );
            publicWatches.push(watch);
          } else {
            watch = await access.watch(agentID, owner, principal);
            privateWatches.push(watch);
            work.delegations.push({
              ...binding,
              kind: "state",
              trace_id: watch.traceID,
            });
          }
          watches.push(watch);
          return watch;
        },
      );
      await pair[0].ready();
      await pair[1].ready();
      assertReadyExecutionState(pair[1].events[0], agentID);
      return pair;
    },
    async beforeStop() {
      work.transport_before = await dependencies.readTransport();
    },
    inventory(phase, rows) {
      assert(["initial", "stopped", "restarted"].includes(phase));
      work.platform_inventory[phase] = structuredClone(rows);
    },
    stopped(stop, stopWindow, remoteClose) {
      work.stop = structuredClone(stop);
      work.stop_window = structuredClone(stopWindow);
      work.remote_acp_close = structuredClone(remoteClose);
      work.remote_acp_connection = clients[0].connectionTraceID;
    },
    remoteClosed(receipt) {
      work.remote_acp_close = structuredClone(receipt);
      work.remote_acp_connection = clients[0].connectionTraceID;
    },
    async afterRestart() {
      work.transport_after = await dependencies.readTransport();
      assertRestoreTransportContinuity(
        work.transport_before,
        work.transport_after,
      );
    },
    idle(audits, model) {
      work.idle.push(structuredClone({ audits, model }));
      assertIdleMaintenance(audits, model);
    },
    history(value) {
      work.histories.push(structuredClone(value));
      return value;
    },
    workspace(before, after, path) {
      work.workspace = structuredClone({ before, after, path });
    },
    membership(phase, raw) {
      (work.membership_logs ??= {})[phase] = raw;
    },
    deleted(resources, agent) {
      work.deletion = structuredClone({ resources, agent });
    },
    close: (client) => client.closeAndWait(),
    closeWatches,
    collectStoppedWatches: collectWatches,
  };
  try {
    signal?.throwIfAborted();
    access = await dependencies.createAccess(config, {
      signal,
      traceDiagnostics: input.traceDiagnostics,
      secrets: traceSecrets,
      watchFactory: openShutdownPrivateWatch,
      collectTrace: collectPrivateShutdownTrace,
    });
    business = await scenario(
      {
        ...input,
        async ready(agentID) {
          const state = await input.ready(agentID);
          work.states.push(structuredClone(state));
          return state;
        },
      },
      adapter,
    );
  } catch (error) {
    errors.push(error);
  } finally {
    await closeWatches();
    await closeRestoreConnections(clients, errors);
    if (!signal?.aborted) {
      try {
        work.final_model = await dependencies.readModel();
        assert.deepEqual(work.final_model, { requests: [], errors: [] });
      } catch (error) {
        errors.push(error);
      }
      try {
        if (input.traceDiagnostics)
          await input.traceDiagnostics.run("recovery-flush", (localSignal) =>
            dependencies.flush(localSignal),
          );
        else await dependencies.flush();
      } catch (error) {
        errors.push(error);
      }
      await collectWatches();
      if (access) {
        try {
          const rows = access
            .snapshots()
            .flatMap((connection) =>
              [connection.initialization, ...connection.evidence].filter(
                Boolean,
              ),
            );
          requestTraces = await collectRestoreTraces(
            rows,
            (row, localSignal = signal) => access.collect(row, [], localSignal),
            (row, error) =>
              dependencies.preserveFailure(row, error, ++failedRequests),
            signal,
            errors,
            input.traceDiagnostics,
          );
        } catch (error) {
          errors.push(error);
        }
      }
    } else errors.push(signal.reason);
    if (access)
      try {
        await access.closeAndWait();
        exporterClosed = true;
      } catch (error) {
        errors.push(error);
      }
  }
  if (signal?.aborted) errors.push(signal.reason);
  return recordShutdownFailures(
    {
      ...business,
      profile: "shutdown",
      project: config.project,
      agent_id: work.states[0]?.agent.agent_id,
      private_shutdown: work,
      private_connections: access?.snapshots() ?? [],
      private_state_watches: access?.watchSnapshots() ?? [],
      request_traces: requestTraces,
      watch_traces: watchTraces,
      private_cleanup_completed:
        exporterClosed && work.public_watches.every((w) => w.joined),
    },
    errors,
  );
}
