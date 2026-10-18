import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  temporaryStorageRoot,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { createFoundationPrivateAccess } from "./foundation-private-access.mjs";
import { collectPrivateRestoreTrace } from "./restore-private-trace.mjs";
import { flushTraceProducers } from "./network-support.mjs";
import {
  readRestoreTransport,
  assertRestoreTransportContinuity,
} from "./restore-private-transport.mjs";
import {
  assertRestoreOwner,
  closeRestoreConnections,
  collectRestoreTraces,
  recordRestoreFailures,
  restoreFailures,
} from "./restore-private-session.mjs";

function sessionDigest(owner) {
  const token = owner.accessToken;
  assert(
    typeof token === "string" && token.length > 0,
    "Restore login Session missing",
  );
  return createHash("sha256").update(token).digest("hex");
}

export async function runPrivateRestore(input, scenario, overrides = {}) {
  const { config, signal } = input;
  const dependencies = {
    createAccess: createFoundationPrivateAccess,
    // mkdtemp creates a private 0700 directory; it is removed only after every
    // connection, collection and exporter has been joined.
    createDirectory: () =>
      mkdtemp(join(temporaryStorageRoot(), "antnest-restore-")),
    removeDirectory: (directory) =>
      rm(directory, { recursive: true, force: true }),
    readTransport: () => readRestoreTransport(config, input.docker),
    flush: () => flushTraceProducers(config, input.docker),
    async readModel() {
      const response = await fetch(config.model + "/status", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.deepEqual(state.errors, []);
      return state.requests;
    },
    preserveFailure: (row, error, index) =>
      writeEvidenceFile(
        config.evidence,
        "restore-private-request-failure-" + index + ".txt",
        inspect({ expected: row, error }, { depth: 8 }),
      ),
    ...overrides,
  };
  const work = {
    creation_principal: input.principal,
    logins: [],
    delegations: [],
    states: [],
    runs: [],
    preserved_runs: [],
    histories: [],
    before_model: [],
    after_model: [],
    provider_requests: [],
    lifecycle_admissions: [],
    pre_restore_connections: [],
  };
  const clients = [],
    errors = [],
    bindings = new Map();
  let access,
    directory,
    business = {},
    recovered = false,
    beforeFrozen = false,
    requestTraces = [],
    exporterClosed = false,
    directoryRemoved = false,
    failedRequests = 0;
  const adapter = {
    login(login) {
      assert.equal(login.response.status, 200);
      assert.match(login.response.traceID, /^[a-f0-9]{32}$/u);
      assert.deepEqual(login.response.body.principal, login.principal);
      assert.equal(work.logins.length, recovered ? 1 : 0);
      const receipt = {
        status: login.response.status,
        trace_id: login.response.traceID,
        principal: structuredClone(login.principal),
        session_digest: sessionDigest(login.owner),
      };
      if (work.logins.length) {
        assert.deepEqual(receipt.principal, work.logins[0].principal);
        assert.notEqual(
          receipt.session_digest,
          work.logins[0].session_digest,
          "Restore requires a new real login Session",
        );
      }
      work.logins.push(receipt);
    },
    async open(agentID, owner, principal) {
      assert.equal(work.logins.length, clients.length + 1);
      const login = work.logins.at(-1);
      assert(
        login,
        "Restore private access requires the original login receipt",
      );
      const digest = sessionDigest(owner);
      assert.equal(
        digest,
        login.session_digest,
        "Restore delegation used another login Session",
      );
      assert.deepEqual(principal, login.principal);
      assertRestoreOwner(
        principal,
        work.creation_principal,
        work.states[0].agent,
        agentID,
      );
      const client = await access.open(agentID, owner, principal);
      clients.push(client);
      work.delegations.push({
        login_index: work.logins.length - 1,
        session_digest: digest,
        connection_trace_id: client.connectionTraceID,
      });
      return client;
    },
    close: (client) => client.closeAndWait(),
    remember(client, method, details) {
      const row = client
        .snapshot()
        .evidence.filter((r) => r.method === method)
        .at(-1);
      assert(row, "actual Restore private request missing");
      for (const name of ["sessionId", "kind", "phase", "toolName"])
        if (details[name] !== undefined)
          assert.deepEqual(row[name], details[name]);
      if (details.runId)
        bindings.set(
          client.connectionTraceID + ":" + row.requestId,
          details.runId,
        );
    },
    recordRun(run) {
      work.runs.push(structuredClone(run));
    },
    preservedRun(run) {
      work.preserved_runs.push(structuredClone(run));
      return run;
    },
    history(value) {
      work.histories.push(structuredClone(value));
      return value;
    },
    modelInventory(value) {
      if (beforeFrozen && !recovered) {
        work.unconfirmed_model = structuredClone(value);
        return;
      }
      work[recovered ? "after_model" : "before_model"] = structuredClone(value);
    },
    async beforeQuiesce() {
      assert.equal(clients.length, 1);
      const closeErrors = [];
      await closeRestoreConnections(clients, closeErrors);
      restoreFailures(closeErrors);
      work.pre_restore_connections = access.snapshots();
      assert(work.pre_restore_connections.every((c) => c.closed));
      work.transport_before = await dependencies.readTransport();
      beforeFrozen = true;
    },
    async afterRestore() {
      recovered = true;
      work.transport_after = await dependencies.readTransport();
      assertRestoreTransportContinuity(
        work.transport_before,
        work.transport_after,
      );
    },
  };
  try {
    signal?.throwIfAborted();
    directory = await dependencies.createDirectory();
    access = await dependencies.createAccess(config, {
      signal,
      secrets: input.traceSecrets,
      collectTrace: collectPrivateRestoreTrace,
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
      directory,
      undefined,
      adapter,
    );
  } catch (error) {
    errors.push(error);
  } finally {
    await closeRestoreConnections(clients, errors);
    if (!signal?.aborted) {
      try {
        adapter.modelInventory(await dependencies.readModel());
      } catch (error) {
        errors.push(error);
      }
      work.provider_requests = [...work.before_model, ...work.after_model];
      try {
        await dependencies.flush();
      } catch (error) {
        errors.push(error);
      }
      if (access) {
        try {
          const rows = access.snapshots().flatMap((connection) =>
            [connection.initialization, ...connection.evidence]
              .filter(Boolean)
              .map((row) => {
                const runId = bindings.get(
                  connection.connectionTraceID + ":" + row.requestId,
                );
                return { ...row, ...(runId ? { runId } : {}) };
              }),
          );
          requestTraces = await collectRestoreTraces(
            rows,
            (row) =>
              access.collect(
                row,
                row.kind === "ordinary"
                  ? work.provider_requests.filter((c) => c.phase === row.phase)
                  : [],
              ),
            (row, error) =>
              dependencies.preserveFailure(row, error, ++failedRequests),
            signal,
            errors,
          );
        } catch (error) {
          errors.push(error);
        }
      }
    } else errors.push(signal.reason);
    if (access) {
      try {
        await access.closeAndWait();
        exporterClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (directory) {
      try {
        await dependencies.removeDirectory(directory);
        directoryRemoved = true;
      } catch (error) {
        errors.push(error);
      }
    }
  }
  return recordRestoreFailures(
    {
      ...business,
      profile: "offline-restore",
      project: config.project,
      completed_runs: work.runs.length,
      model_requests: work.provider_requests.length,
      request_traces: requestTraces,
      private_connections: access?.snapshots() ?? [],
      private_restore: work,
      private_cleanup_completed: exporterClosed && directoryRemoved,
    },
    errors,
  );
}
