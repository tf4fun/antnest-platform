import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect, isDeepStrictEqual } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { assertRestoreOwner } from "../lifecycle-closeout/restore-private-session.mjs";
import { flushTraceProducers } from "../lifecycle-closeout/network-support.mjs";
import { runtimeStatus } from "../lifecycle-closeout/runtime-status.mjs";
import { runtimeBinding } from "./current-evidence.mjs";
import { createWorkspacePrivateAccess } from "./private-access.mjs";
import { assertWorkspaceWatchReceipt } from "./private-watch.mjs";
import {
  projectWorkspaceRequest,
  workspaceRequestKey,
} from "./private-requests.mjs";

export function recordWorkspaceFailures(result, errors) {
  if (!Object.hasOwn(result, "workspaceErrors"))
    Object.defineProperty(result, "workspaceErrors", { value: [] });
  result.workspaceErrors.push(...errors);
  result.private_collection_errors = [...new Set(result.workspaceErrors)].map(
    (error) => inspect(error, { depth: 8 }),
  );
  return result;
}
export function workspaceFailures(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Workspace business, evidence or cleanup failed",
    );
}
export function workspacePublicResult(result) {
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => !key.startsWith("private_")),
  );
}
function withWorkspaceDiagnostics(
  result,
  diagnostics,
  exporter = result.trace_diagnostics?.exporter,
) {
  const summary = diagnostics.summary();
  result.trace_diagnostics = {
    ...summary,
    ...(exporter ? { exporter } : {}),
    status:
      summary.status === "warning" || exporter?.status === "warning"
        ? "warning"
        : summary.status,
  };
  Object.defineProperty(result, "workspaceDiagnostics", { value: diagnostics });
  return result;
}
async function collectWorkspaceTrace(
  diagnostics,
  name,
  row,
  collect,
  preserve,
) {
  return diagnostics.run(name, async (localSignal) => {
    try {
      return await collect(row, localSignal);
    } catch (error) {
      try {
        await preserve(row, error);
      } catch (archiveError) {
        throw new AggregateError(
          [error, archiveError],
          "Workspace Trace collection and diagnostic archive failed",
        );
      }
      throw error;
    }
  });
}
export async function collectWorkspaceLifecycles(
  result,
  admitted,
  collect,
  preserve,
  signal,
  diagnostics = result.workspaceDiagnostics,
) {
  assert(
    diagnostics &&
      typeof diagnostics.run === "function" &&
      typeof diagnostics.summary === "function",
    "shared Workspace Trace diagnostics required",
  );
  result.private_workspace.lifecycle_admissions = structuredClone(admitted);
  const errors = [],
    traces = [];
  for (const [index, row] of admitted.entries()) {
    if (signal?.aborted) break;
    try {
      const diagnostic = await collectWorkspaceTrace(
        diagnostics,
        `workspace-lifecycle-${index + 1}`,
        row,
        (expected, localSignal) =>
          collect(
            expected,
            signal ? AbortSignal.any([signal, localSignal]) : localSignal,
          ),
        preserve,
      );
      traces.push(
        diagnostic.status === "passed"
          ? { ...diagnostic.value, topology: "passed" }
          : {
              trace_id: row.traceID,
              request_id: row.requestID ?? row.requestId,
              agent_id: row.agentID ?? row.agentId,
              kind: row.kind,
              topology: "failed",
              strict_trace: "failed",
              diagnostic,
            },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (signal?.aborted) errors.push(signal.reason);
  return withWorkspaceDiagnostics(
    recordWorkspaceFailures(
      { ...result, operations: admitted.length, traces },
      [...(result.workspaceErrors ?? []), ...errors],
    ),
    diagnostics,
  );
}
const digest = (owner) => {
  assert(
    typeof owner.accessToken === "string" && owner.accessToken,
    "original Workspace Session required",
  );
  return createHash("sha256").update(owner.accessToken).digest("hex");
};
const collectors = () => import("./private-collectors.mjs");

export async function runPrivateWorkspace(input, scenario, overrides = {}) {
  const { config, signal, traceSecrets } = input;
  const diagnostics = createTraceDiagnostics({
    directory: config.evidence,
    signal,
    budgetMs: overrides.diagnosticBudgetMs ?? 60_000,
  });
  const common = {
    directory: config.evidence + "/traces",
    secrets: traceSecrets,
    signal,
  };
  const dependencies = {
    createAccess: createWorkspacePrivateAccess,
    owner: () => new GatewayClient(config.gateway),
    now: Date.now,
    status: (observed) =>
      runtimeStatus(input.docker, config.project, observed.container.Id),
    persist: (name, value) =>
      writeEvidenceFile(
        config.evidence,
        `${name}.private.json`,
        JSON.stringify(value),
      ),
    preserveFailure: (row, error, index) =>
      writeEvidenceFile(
        config.evidence,
        `workspace-trace-failure-${index}.private.txt`,
        inspect({ expected: row, error }, { depth: 8 }),
      ),
    flush: () => flushTraceProducers(config, input.docker),
    async readModel() {
      const response = await fetch(config.model + "/status", {
        signal: AbortSignal.any(
          [signal, AbortSignal.timeout(5000)].filter(Boolean),
        ),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    collectRequest: async (...args) =>
      (await collectors()).collectWorkspacePrivateRequest(...args),
    collectHTTP: async (expected, localSignal) =>
      (await collectors()).collectWorkspacePrivateHTTP(
        config.jaeger,
        expected,
        { ...common, signal: localSignal, flush: () => access.flush() },
      ),
    collectNotification: async (receipt, localSignal) =>
      (await collectors()).collectWorkspacePrivateNotification(
        config.jaeger,
        receipt,
        { ...common, signal: localSignal, flush: () => access.flush() },
      ),
    collectAuthority: async (expected, localSignal) =>
      (await collectors()).collectWorkspaceAuthorityTrace(
        config.jaeger,
        expected,
        { ...common, signal: localSignal, flush: () => access.flush() },
      ),
    collectOffboarding: async (expected, localSignal) =>
      (await collectors()).collectWorkspaceOffboarding(
        config,
        expected,
        traceSecrets,
        localSignal,
      ),
    ...overrides,
  };
  const work = {
    creation_principal: input.principal,
    logins: [],
    initial_agent: undefined,
    observations: [],
    bindings: [],
    business: {},
    watch_windows: [],
    denied_connections: [],
    offboarding: [],
    lifecycle_admissions: [],
    held_results: [],
    final_model: undefined,
  };
  const clients = [],
    watches = [],
    pending = [],
    errors = [],
    annotations = new Map(),
    watchWindows = new Map();
  const groups = {
    request_traces: [],
    watch_traces: [],
    state_traces: [],
    notification_traces: [],
    authority_traces: [],
    offboarding_traces: [],
  };
  let access,
    business = {},
    exporterJoined = false,
    resourcesJoined = true,
    traceIndex = 0,
    failureIndex = 0;
  let originalDisconnects = [],
    originalNotifications = [];
  const snapshots = {
    connections: [],
    watches: [],
    states: [],
    authorities: [],
  };
  async function attempt(callback) {
    try {
      return await callback();
    } catch (error) {
      errors.push(error);
      return undefined;
    }
  }
  function bind(agentID, owner, principal) {
    assert.equal(
      work.logins.length,
      1,
      "one original Workspace login required",
    );
    assert(
      digest(owner) === work.logins[0].session_digest,
      "Workspace replaced its original login",
    );
    assert(
      isDeepStrictEqual(principal, work.logins[0].principal),
      "Workspace delegated a foreign Principal",
    );
    assertRestoreOwner(
      principal,
      work.creation_principal,
      work.initial_agent,
      agentID,
    );
  }
  const principalFields = (row) => ({
    agentID: row.agentId,
    traceID: row.traceID,
    clientSpanID: row.clientSpanID,
    principal: structuredClone(work.logins[0]?.principal),
    session_digest: work.logins[0]?.session_digest,
    receipt: row,
  });
  async function readModel() {
    const model = await dependencies.readModel();
    work.final_model = structuredClone(model);
    assert(
      isDeepStrictEqual(model.errors, []),
      "unexpected Workspace Provider execution",
    );
    assert(Array.isArray(model.requests));
    return structuredClone(model.requests);
  }
  async function closeWatch(watch) {
    let observed = watchWindows.get(watch.traceID);
    if (!observed) {
      observed = {
        traceID: watch.traceID,
        mode: "local-close",
        window: { start: dependencies.now() },
      };
      watchWindows.set(watch.traceID, observed);
      work.watch_windows.push(observed);
    }
    await watch.closeAndWait();
    observed.window.end ??= dependencies.now();
  }
  const adapter = {
    owner: dependencies.owner,
    login(owner, response, agent, agentID) {
      assert.equal(
        work.logins.length,
        0,
        "Workspace must reuse its original login",
      );
      assert.equal(response.status, 200);
      const principal = response.body.principal;
      assertRestoreOwner(principal, input.principal, agent, agentID);
      work.initial_agent = structuredClone(agent);
      work.logins.push({
        status: response.status,
        trace_id: response.traceID,
        principal: structuredClone(principal),
        session_digest: digest(owner),
      });
      return structuredClone(principal);
    },
    async open(agentID, owner, principal) {
      bind(agentID, owner, principal);
      const client = await access.open(agentID, owner, principal);
      clients.push(client);
      return client;
    },
    async watch(agentID, owner, principal) {
      bind(agentID, owner, principal);
      const watch = await access.watch(agentID, owner, principal);
      watches.push(watch);
      return watch;
    },
    state(agentID, owner, principal) {
      bind(agentID, owner, principal);
      return access.state(agentID, owner, principal);
    },
    async denyNewConnection(agentID, owner, principal, boundary) {
      bind(agentID, owner, principal);
      work.denied_connections.push({ agentID, after: boundary.after });
      return access.denyNewConnection(agentID, owner, principal, boundary);
    },
    remember(client, method, extra = {}) {
      assert(
        clients.includes(client),
        "foreign Workspace connection annotation",
      );
      const row = client.requests
        .filter((item) => item.method === method)
        .at(-1);
      assert(row, "actual Workspace wire request missing");
      const observed = {
        ...structuredClone(extra),
        connectionTraceID: client.connectionTraceID,
        requestId: row.requestId,
        method,
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        label: `workspace-${work.observations.length}-${method}`,
      };
      if (extra.sessionId !== undefined && row.sessionId !== undefined)
        assert(
          extra.sessionId === row.sessionId,
          "Workspace annotated a foreign Session",
        );
      const key = workspaceRequestKey(observed);
      assert(!annotations.has(key), "duplicate Workspace request annotation");
      annotations.set(key, observed);
      work.observations.push(observed);
      return observed;
    },
    hold(promise) {
      pending.push(promise);
    },
    async binding(observed) {
      const status = await dependencies.status(observed);
      const binding = runtimeBinding(observed, status);
      work.bindings.push({
        observed: structuredClone(observed),
        status: structuredClone(status),
        binding: structuredClone(binding),
      });
      return binding;
    },
    record(name, value) {
      assert(
        ["cancel", "offline", "rebuilt", "revocation", "deleted"].includes(
          name,
        ),
      );
      assert(
        !Object.hasOwn(work.business, name),
        "duplicate Workspace business proof",
      );
      work.business[name] = structuredClone(value);
    },
    persist: dependencies.persist,
    modelState: readModel,
    closeWatch,
    beginRevocation(watch) {
      assert(watches.includes(watch));
      assert(
        !watchWindows.has(watch.traceID),
        "Workspace watch closure already began",
      );
      const baseline = watch.beginRevocation();
      const observation = {
        traceID: watch.traceID,
        mode: "revocation",
        revocationStart: structuredClone(baseline),
        window: { start: baseline.observedAt },
      };
      watchWindows.set(watch.traceID, observation);
      work.watch_windows.push(observation);
      return baseline;
    },
    async revoked(watch, traceID) {
      const observation = watchWindows.get(watch.traceID);
      assert.equal(observation?.mode, "revocation");
      observation.revocationTraceID = traceID;
      await watch.wait(
        (state) => state.access_allowed === false,
        observation.revocationStart.receivedEvents,
      );
      await watch.waitClosed();
      observation.window.end = dependencies.now();
      await watch.closeAndWait();
      const receipt = watch.snapshot();
      assertWorkspaceWatchReceipt(
        receipt,
        {
          ...principalFields(receipt),
          ...observation,
        },
        { requireTrace: false },
      );
    },
    offboarding(expected) {
      work.offboarding.push(structuredClone(expected));
    },
  };
  async function capture() {
    if (!access) return;
    for (const [key, method] of [
      ["connections", "snapshots"],
      ["watches", "watchSnapshots"],
      ["states", "stateReceipts"],
      ["authorities", "authoritySnapshots"],
    ]) {
      try {
        const value = await access[method]();
        assert(Array.isArray(value), "original Workspace inventory required");
        snapshots[key] = value;
      } catch (error) {
        resourcesJoined = false;
        errors.push(error);
      }
    }
  }
  async function collect(rows, destination, callback, prepare = (row) => row) {
    for (const row of rows) {
      if (signal?.aborted) break;
      const identity = row.raw ?? row;
      const identifiers = {
        trace_id: identity.traceID,
        request_id: identity.requestId,
        connection_trace_id: identity.connectionTraceID,
        agent_id: identity.agentID ?? identity.agentId,
        kind: identity.kind,
        method: identity.method,
      };
      let prepared,
        projectionFailed = false,
        projectionError;
      try {
        // Original request bytes and their projection are business evidence,
        // even when the shared diagnostic budget has already been exhausted.
        prepared = prepare(row);
      } catch (error) {
        projectionFailed = true;
        projectionError = error;
        errors.push(error);
      }
      const diagnostic = await attempt(() =>
        collectWorkspaceTrace(
          diagnostics,
          `workspace-trace-${++traceIndex}`,
          prepared,
          async (expected, localSignal) => {
            if (projectionFailed) throw projectionError;
            return callback(expected, localSignal);
          },
          (_expected, error) =>
            dependencies.preserveFailure(identity, error, ++failureIndex),
        ),
      );
      destination.push(
        diagnostic?.status === "passed"
          ? { ...identifiers, ...diagnostic.value }
          : {
              ...identifiers,
              topology: "failed",
              strict_trace: "failed",
              ...(diagnostic ? { diagnostic } : {}),
            },
      );
    }
  }
  try {
    signal?.throwIfAborted();
    access = await dependencies.createAccess(config, {
      signal,
      secrets: traceSecrets,
      collectTrace: (base, expected, options) =>
        dependencies.collectRequest(base, expected, options, {
          receipt: originalDisconnects.find(
            (receipt) =>
              workspaceRequestKey(receipt) === workspaceRequestKey(expected),
          ),
        }),
    });
    business = (await scenario(input, adapter)) ?? {};
  } catch (error) {
    errors.push(error);
  } finally {
    for (const watch of watches) {
      try {
        await closeWatch(watch);
      } catch (error) {
        resourcesJoined = false;
        errors.push(error);
      }
    }
    for (const client of clients) {
      try {
        await client.closeAndWait();
      } catch (error) {
        resourcesJoined = false;
        errors.push(error);
      }
    }
    for (const promise of pending) {
      await attempt(async () => {
        const result = await promise;
        work.held_results.push(
          result.error
            ? { error: inspect(result.error, { depth: 8 }) }
            : { value: structuredClone(result.value) },
        );
        if (
          result.error &&
          !clients.some(
            (client) =>
              client.disconnectReceipts?.length &&
              client.isLocalCloseError(result.error),
          )
        )
          errors.push(result.error);
      });
    }
    await capture();
    if (access) {
      originalDisconnects =
        (await attempt(() => access.disconnectReceipts())) ?? [];
      originalNotifications =
        (await attempt(() => access.notificationReceipts())) ?? [];
    }
    if (!signal?.aborted) {
      await attempt(readModel);
      // This flush stops the actual service producers and verifies their exit
      // codes. Its Docker deadline and cleanup failures remain business gates.
      await attempt(() => dependencies.flush());
      if (access)
        await attempt(() =>
          diagnostics.run("workspace-private-flush", () => access.flush()),
        );
      const rows = snapshots.connections.flatMap((connection) =>
        [connection.initialization, ...connection.evidence]
          .filter(Boolean)
          .map((raw) => ({ connection, raw })),
      );
      await collect(
        rows,
        groups.request_traces,
        (expected, localSignal) =>
          access.collect(
            expected,
            (work.final_model?.requests ?? []).filter(
              (row) => expected.phase && row.phase === expected.phase,
            ),
            { signal: localSignal },
          ),
        ({ connection, raw }) =>
          projectWorkspaceRequest(
            connection,
            raw,
            annotations.get(workspaceRequestKey(raw)),
          ),
      );
      await collect(
        snapshots.watches.map((receipt) => ({
          ...principalFields(receipt),
          ...watchWindows.get(receipt.traceID),
          kind: "private_state_watch",
        })),
        groups.watch_traces,
        dependencies.collectHTTP,
      );
      await collect(
        snapshots.states.map((receipt) => ({
          ...principalFields(receipt),
          kind: "private_state",
        })),
        groups.state_traces,
        dependencies.collectHTTP,
      );
      await collect(
        originalNotifications,
        groups.notification_traces,
        dependencies.collectNotification,
      );
      const authorityRows = snapshots.authorities.flatMap((scope) =>
        scope.receipts.map((receipt) => ({
          ...principalFields(receipt),
          kind: "workspace_identity",
          scope: {
            operation_id: scope.operation_id,
            kind: scope.kind,
            index: scope.index,
          },
          ...(scope.kind === "denied-connection"
            ? {
                after: work.denied_connections.find(
                  (row) => row.agentID === receipt.agentId,
                )?.after,
              }
            : {}),
        })),
      );
      await collect(
        authorityRows,
        groups.authority_traces,
        dependencies.collectAuthority,
      );
      await collect(
        work.offboarding,
        groups.offboarding_traces,
        dependencies.collectOffboarding,
      );
    }
    // Stopping the access object first would forbid its remaining collectors.
    // It owns late openings, archive joins and the final exporter shutdown.
    if (access) {
      try {
        await access.closeAndWait();
        exporterJoined = true;
      } catch (error) {
        errors.push(error);
      }
      await capture();
    }
    await attempt(() => dependencies.persist("requests", work.observations));
    await attempt(() => dependencies.persist("model", work.final_model));
    await attempt(() =>
      dependencies.persist("workspace-private", {
        work,
        ...snapshots,
        ...groups,
      }),
    );
  }
  if (signal?.aborted) errors.push(signal.reason);
  const cleanupCompleted =
    exporterJoined && resourcesJoined && !signal?.aborted;
  return withWorkspaceDiagnostics(
    recordWorkspaceFailures(
      {
        ...business,
        profile: "workspace-protocol",
        project: config.project,
        agent_id: work.initial_agent?.agent_id,
        ...(business.deleted_before_teardown
          ? { completed_prompts: 2, cancel_recovery: "explicit_rebuild" }
          : {}),
        private_workspace: work,
        private_connections: snapshots.connections,
        private_state_watches: snapshots.watches,
        private_state_receipts: snapshots.states,
        private_authority_receipts: snapshots.authorities,
        private_notifications: structuredClone(originalNotifications),
        private_disconnects: structuredClone(originalDisconnects),
        ...groups,
        private_cleanup_completed: cleanupCompleted,
        ...(cleanupCompleted
          ? {
              private_resource_cleanup: {
                version: 1,
                status: "joined",
                connections: snapshots.connections.length,
                watches: snapshots.watches.length,
                state_receipts: snapshots.states.length,
                authority_receipts: snapshots.authorities.length,
              },
            }
          : {}),
      },
      errors,
    ),
    diagnostics,
    access?.traceDiagnostics?.(),
  );
}
