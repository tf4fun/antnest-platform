import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { serviceClient } from "../../support/service-grants.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";
import { createWorkspacePrivateAccess } from "../workspace-closeout/private-access.mjs";
import { createWorkspaceAuthority } from "../workspace-closeout/private-authority.mjs";
import { readWorkspacePrivateState } from "../workspace-closeout/private-state.mjs";
import { assertWorkspaceWatchReceipt } from "../workspace-closeout/private-watch.mjs";

function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(unique, "Stage2 private resources failed");
}

export async function createStage2PrivateAccess(
  config,
  { secrets, signal } = {},
) {
  assert(Array.isArray(secrets));
  const dependencyRoot = new URL(
    "../../../services/agent-acp-service/package.json",
    import.meta.url,
  ).href;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "ws" ||
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
      import("./stage2-private-connection.mjs"),
      import("./stage2-private-http.mjs"),
    ]);
  } finally {
    hook.deregister();
  }
  signal?.throwIfAborted();
  const [
    { createPrivateACPTelemetry },
    { openStage2Connection },
    { openStage2HTTP },
  ] = modules;
  const httpEntries = [],
    pending = new Set(),
    errors = [];
  let closing, telemetry;
  const ws = await createWorkspacePrivateAccess(config, {
    secrets,
    signal,
    factories: {
      telemetry(endpoint) {
        telemetry = createPrivateACPTelemetry(endpoint);
        return telemetry;
      },
      connection(agentId, browser, options) {
        return openStage2Connection(agentId, browser, {
          ...options,
          endpoint: new URL("/v2/acp", options.endpoint).href,
        });
      },
      async state(agentId, browser, options) {
        try {
          return await readWorkspacePrivateState(agentId, browser, options);
        } catch (error) {
          if (!(error instanceof PrivateACPExecutionStateUnavailableError))
            throw error;
          // Only the reader's exact original, joined 503 is an expected cold state.
          const receipt = options.receipts.at(-1);
          assert.equal(receipt.status, 503);
          assert.equal(receipt.joined, true);
          return JSON.parse(Buffer.from(receipt.raw_body_base64, "base64"));
        }
      },
    },
  });
  const paths = {
    "gateway-identity": "edge-gateway/tokens/identity-service",
    "agent-ui-acp": "agent-ui/tokens/agent-acp-service",
  };
  const base = serviceClient({
    identityEndpoint: config.privateAccess.identity,
    readCredential(grant) {
      assert(Object.hasOwn(paths, grant));
      return readFileSync(
        join(config.privateAccess.credentials, paths[grant]),
        "utf8",
      );
    },
  });
  const authorityRows = (entry) =>
    entry.authorities.flatMap((record) => record.authority.snapshot());
  const httpSnapshot = (entry, snapshot = entry.client.snapshot()) => ({
    ...snapshot,
    authority: authorityRows(entry),
    authority_cancellations: entry.cancellations,
  });
  async function preserve(entry, snapshot) {
    try {
      writeEvidenceFile(
        config.evidence,
        `private-http-${entry.index}.json`,
        JSON.stringify(httpSnapshot(entry, snapshot)),
      );
    } catch (error) {
      errors.push(error);
      throw error;
    }
  }
  const access = Object.create(ws);
  function admitted() {
    assert(!closing, "Stage2 private resources are closing");
    signal?.throwIfAborted();
  }
  for (const method of ["open", "watch", "state", "denyNewConnection", "flush"])
    access[method] = (...args) => {
      admitted();
      return ws[method](...args);
    };
  access.httpSnapshots = () =>
    httpEntries
      .filter((entry) => entry.client)
      .map((entry) => httpSnapshot(entry));
  access.openHTTP = (agentId, browser, principal) => {
    admitted();
    const entry = {
      index: httpEntries.length + 1,
      authorities: [],
      cancellations: [],
    };
    httpEntries.push(entry);
    const service = Object.create(base);
    service.workspaceContext = async (token, requestedAgent, options) => {
      const httpRequest = structuredClone(options.httpRequest);
      assert(Number.isSafeInteger(httpRequest.index) && httpRequest.index >= 0);
      assert(["POST", "GET", "DELETE"].includes(httpRequest.method));
      assert(
        !entry.authorities.some(
          (record) => record.httpRequest.index === httpRequest.index,
        ),
      );
      const authority = createWorkspaceAuthority({
        service: base,
        identityEndpoint: config.privateAccess.identity,
        agentId,
        browser,
        principal,
        secrets,
        telemetry,
        preserve() {
          try {
            writeEvidenceFile(
              config.evidence,
              `private-http-authority-${entry.index}.json`,
              JSON.stringify(authorityRows(entry)),
            );
          } catch (error) {
            errors.push(error);
            throw error;
          }
        },
      });
      const record = { authority, httpRequest, signal: options.signal };
      entry.authorities.push(record);
      const failures = [];
      let issued;
      try {
        issued = await authority.service.workspaceContext(
          token,
          requestedAgent,
          options,
        );
      } catch (error) {
        failures.push(error);
      }
      // This scope owns the Resolve operation, whose lifetime ends before the
      // subsequent HTTP stream. A later GET cancellation is not a Resolve error.
      try {
        await authority.closeAndWait();
      } catch (error) {
        failures.push(error);
      }
      if (
        failures.length &&
        options.signal.aborted &&
        failures.every((error) => error === options.signal.reason)
      )
        record.cancellation = options.signal.reason;
      fail(failures);
      return issued;
    };
    const task = (async () => {
      entry.client = await openStage2HTTP(agentId, browser, {
        principal,
        secrets,
        signal,
        telemetry,
        service,
        endpoint: new URL("/v1/acp", config.privateAccess.acp).href,
        preserve: (snapshot) => preserve(entry, snapshot),
      });
      return entry.client;
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error) => {
        errors.push(error);
        pending.delete(task);
      },
    );
    return task;
  };
  access.firstState = async (agentId, browser, principal) => {
    admitted();
    const start = Date.now();
    const watch = await ws.watch(agentId, browser, principal);
    const failures = [];
    let value, receipt;
    try {
      value = await watch.ready();
    } catch (error) {
      failures.push(error);
    }
    try {
      receipt = await watch.closeAndWait();
    } catch (error) {
      failures.push(error);
    }
    if (receipt)
      try {
        assertWorkspaceWatchReceipt(receipt, {
          mode: "local-close",
          agentID: agentId,
          principal,
          session_digest: createHash("sha256")
            .update(browser.accessToken)
            .digest("hex"),
          traceID: receipt.traceID,
          clientSpanID: receipt.clientSpanID,
          window: { start, end: Date.now() },
        });
      } catch (error) {
        failures.push(error);
      }
    fail(failures);
    return value;
  };
  access.closeAndWait = () => {
    if (!closing)
      closing = Promise.resolve().then(async () => {
        const failures = [];
        const attempt = async (work) => {
          try {
            await work();
          } catch (error) {
            failures.push(error);
          }
        };
        while (pending.size) await Promise.allSettled([...pending]);
        for (const entry of httpEntries) {
          if (entry.client) await attempt(() => entry.client.closeAndWait());
          for (const [index, record] of entry.authorities.entries()) {
            try {
              await record.authority.closeAndWait();
            } catch (error) {
              const snapshot = entry.client?.snapshot();
              const receipt = snapshot?.http.requests.find(
                (row) => row.index === record.httpRequest.index,
              );
              const original = record.authority.snapshot();
              const cancelled =
                record.cancellation &&
                error === record.cancellation &&
                error === record.signal.reason &&
                record.signal.aborted &&
                snapshot?.closed &&
                snapshot.http.streamJoined &&
                snapshot.http.pendingRequests === 0 &&
                snapshot.http.failures.length === 0 &&
                record.httpRequest.method === "GET" &&
                receipt?.method === "GET" &&
                receipt.bodyOutcome === "cancelled" &&
                !receipt.wireStarted &&
                !receipt.failed &&
                original.length === 1 &&
                original[0].client_ended;
              if (cancelled)
                entry.cancellations.push({
                  authority_index: index,
                  http_request_index: receipt.index,
                });
              else failures.push(error);
            }
          }
          if (entry.client)
            await attempt(() => preserve(entry, entry.client.snapshot()));
        }
        // The HTTP DELETE and its independent Resolve must finish before the
        // shared exporter is shut down by the WebSocket/state resource owner.
        await attempt(() => ws.closeAndWait());
        if (signal?.aborted) failures.push(signal.reason);
        fail([...failures, ...errors]);
      });
    void closing.catch(() => {});
    return closing;
  };
  return access;
}
