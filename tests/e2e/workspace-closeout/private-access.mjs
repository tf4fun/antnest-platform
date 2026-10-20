import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { serviceClient } from "../../support/service-grants.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import {
  createWorkspaceAuthority,
  assertWorkspaceResolveDenied,
} from "./private-authority.mjs";

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
    "Workspace private endpoint must be loopback",
  );
  return path === "/" ? url.origin : url.href;
}
function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(unique, "Workspace private resources failed");
}

export async function createWorkspacePrivateAccess(
  config,
  {
    signal,
    secrets,
    collectTrace,
    factories = {},
    preserveConnection = (index, value) =>
      writeEvidenceFile(
        config.evidence,
        `private-connection-${index}.json`,
        JSON.stringify(value),
      ),
    preserveWatch = (index, value) =>
      writeEvidenceFile(
        config.evidence,
        `private-watch-${index}.json`,
        JSON.stringify(value),
      ),
    preserveState = (index, value) =>
      writeEvidenceFile(
        config.evidence,
        `private-state-${index}.json`,
        JSON.stringify(value),
      ),
    preserveAuthority = (scope, rows) =>
      writeEvidenceFile(
        config.evidence,
        `private-authority-${scope.operation_id}.json`,
        JSON.stringify({ ...scope, receipts: rows }),
      ),
  } = {},
) {
  signal?.throwIfAborted();
  assert(Array.isArray(secrets));
  for (const callback of [
    preserveConnection,
    preserveWatch,
    preserveState,
    preserveAuthority,
  ])
    assert.equal(typeof callback, "function");
  assert(collectTrace === undefined || typeof collectTrace === "function");
  for (const [key, factory] of Object.entries(factories)) {
    assert(
      ["connection", "watch", "state", "telemetry"].includes(key),
      "unknown Workspace factory",
    );
    assert.equal(typeof factory, "function");
  }
  const privateAccess = config.privateAccess;
  assert(
    typeof privateAccess?.credentials === "string" &&
      privateAccess.credentials.startsWith("/"),
  );
  const acp = loopback(privateAccess.acp),
    identity = loopback(privateAccess.identity),
    otlp = loopback(privateAccess.otlp, "/v1/traces");
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
      import("./private-connection.mjs"),
      import("./private-watch.mjs"),
      import("./private-state.mjs"),
    ]);
  } finally {
    hook.deregister();
  }
  signal?.throwIfAborted();
  const [
    { createPrivateACPTelemetry },
    { openWorkspaceConnection },
    { openWorkspacePrivateWatch },
    { readWorkspacePrivateState },
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
        "Workspace private grant is not allowed",
      );
      return readFileSync(
        join(privateAccess.credentials, paths[grant]),
        "utf8",
      );
    },
  });
  const telemetry = (factories.telemetry ?? createPrivateACPTelemetry)(otlp);
  const open = factories.connection ?? openWorkspaceConnection,
    watch = factories.watch ?? openWorkspacePrivateWatch,
    state = factories.state ?? readWorkspacePrivateState;
  const entries = [],
    pending = new Set(),
    collecting = new Set(),
    operationErrors = [],
    archiveErrors = [];
  let closing,
    connectionIndex = 0,
    watchIndex = 0,
    stateIndex = 0;
  const scopeOf = (entry) => ({
    operation_id: entry.id,
    kind: entry.kind,
    index: entry.index,
  });
  const decorated = (entry, value) => ({
    ...structuredClone(value),
    authority_scope: entry.id,
    authority: entry.authority.snapshot(),
  });
  async function archive(callback, ...args) {
    try {
      await callback(...args);
    } catch (error) {
      archiveErrors.push(error);
      throw error;
    }
  }
  function admitted() {
    assert(!closing, "Workspace private resources are closing");
    signal?.throwIfAborted();
  }
  function track(work, group = pending) {
    const task = Promise.resolve().then(work);
    group.add(task);
    void task.then(
      () => group.delete(task),
      (error) => {
        operationErrors.push(error);
        group.delete(task);
      },
    );
    return task;
  }
  function begin(kind, agentId, browser, principal, work) {
    admitted();
    const entry = {
      id: entries.length + 1,
      kind,
      index:
        kind === "watch"
          ? ++watchIndex
          : kind === "state"
            ? ++stateIndex
            : ++connectionIndex,
      states: [],
    };
    entry.authority = createWorkspaceAuthority({
      service,
      identityEndpoint: identity,
      agentId,
      browser,
      principal,
      signal,
      secrets,
      telemetry,
      preserve: (rows) => archive(preserveAuthority, scopeOf(entry), rows),
    });
    entries.push(entry);
    const options = {
      principal,
      service: entry.authority.service,
      signal,
      secrets,
      telemetry,
    };
    return track(() => work(entry, options));
  }
  async function connection(entry, options, agentId, browser) {
    const resource = await open(agentId, browser, {
      ...options,
      endpoint: acp + "/v1/acp",
      preserve: (value) =>
        archive(preserveConnection, entry.index, decorated(entry, value)),
    });
    entry.resource = resource;
    return resource;
  }
  return {
    snapshots: () =>
      entries
        .filter((entry) => entry.resource && entry.kind !== "watch")
        .map((entry) => decorated(entry, entry.resource.snapshot())),
    watchSnapshots: () =>
      entries
        .filter((entry) => entry.resource && entry.kind === "watch")
        .map((entry) => decorated(entry, entry.resource.snapshot())),
    stateReceipts: () =>
      entries.flatMap((entry) =>
        entry.states.map((row) => decorated(entry, row)),
      ),
    authoritySnapshots: () =>
      entries.map((entry) => ({
        ...scopeOf(entry),
        receipts: entry.authority.snapshot(),
      })),
    disconnectReceipts: () =>
      entries.flatMap((entry) => entry.resource?.disconnectReceipts ?? []),
    notificationReceipts: () =>
      entries.flatMap((entry) => entry.resource?.notificationReceipts ?? []),
    open(agentId, browser, principal) {
      return begin(
        "connection",
        agentId,
        browser,
        principal,
        (entry, options) => connection(entry, options, agentId, browser),
      );
    },
    watch(agentId, browser, principal) {
      return begin(
        "watch",
        agentId,
        browser,
        principal,
        async (entry, options) => {
          entry.resource = await watch(agentId, browser, {
            ...options,
            endpoint: acp + "/rpc/agent-acp/watch-agent-execution-state",
            preserve: (value) =>
              archive(preserveWatch, entry.index, decorated(entry, value)),
          });
          return entry.resource;
        },
      );
    },
    state(agentId, browser, principal) {
      return begin("state", agentId, browser, principal, (entry, options) =>
        state(agentId, browser, {
          ...options,
          endpoint: acp + "/rpc/agent-acp/get-agent-execution-state",
          receipts: entry.states,
          preserve: (value) =>
            archive(preserveState, entry.index, decorated(entry, value)),
        }),
      );
    },
    denyNewConnection(agentId, browser, principal, { after }) {
      const digest = createHash("sha256")
        .update(browser.accessToken)
        .digest("hex");
      return begin(
        "denied-connection",
        agentId,
        browser,
        principal,
        async (entry, options) => {
          let original;
          try {
            await connection(entry, options, agentId, browser);
          } catch (error) {
            original = error;
          }
          try {
            assert(
              !entry.resource,
              "revoked Workspace connection was accepted",
            );
            assert(original, "Workspace connection attempt did not reject");
            await entry.authority.closeAndWait();
            signal?.throwIfAborted();
            const rows = entry.authority.snapshot();
            assert.equal(
              rows.length,
              1,
              "original Workspace Resolve attempt required",
            );
            assertWorkspaceResolveDenied(rows[0], {
              agentID: agentId,
              principal,
              session_digest: digest,
              after,
            });
            return rows[0];
          } catch (error) {
            fail([...(original ? [original] : []), error]);
          }
        },
      );
    },
    flush() {
      admitted();
      return track(() => telemetry.flush(), collecting);
    },
    collect(expected, requests) {
      admitted();
      assert.equal(
        typeof collectTrace,
        "function",
        "Workspace-owned collector required",
      );
      return track(
        () =>
          collectTrace(config.jaeger, expected, {
            directory: config.evidence + "/traces",
            secrets,
            requests,
            signal,
            flush: () => telemetry.flush(),
          }),
        collecting,
      );
    },
    closeAndWait() {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          const errors = [];
          const attempt = async (work) => {
            try {
              await work();
            } catch (error) {
              errors.push(error);
            }
          };
          // An opening operation owns its future resource before its first await.
          // Join late registrations before ending any of their CLIENT producers.
          while (pending.size) await Promise.allSettled([...pending]);
          for (const entry of entries) {
            if (entry.resource)
              await attempt(() => entry.resource.closeAndWait());
            await attempt(() => entry.authority.closeAndWait());
            if (entry.resource)
              await attempt(() =>
                archive(
                  entry.kind === "watch" ? preserveWatch : preserveConnection,
                  entry.index,
                  decorated(entry, entry.resource.snapshot()),
                ),
              );
            for (const row of entry.states)
              await attempt(() =>
                archive(preserveState, entry.index, decorated(entry, row)),
              );
          }
          // A collector can require the finished Span from a just-closed watch
          // or connection. Keep its exporter alive until that collection joins.
          while (collecting.size) await Promise.allSettled([...collecting]);
          await attempt(() => telemetry.shutdown());
          if (signal?.aborted) errors.push(signal.reason);
          fail([...errors, ...operationErrors, ...archiveErrors]);
        });
        void closing.catch(() => {});
      }
      return closing;
    },
  };
}
