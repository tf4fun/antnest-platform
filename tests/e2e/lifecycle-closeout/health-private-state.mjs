import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { registerHooks } from "node:module";
import { serviceClient } from "../../support/service-grants.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { assertHealthProjection } from "./health-evidence.mjs";

export function throwHealthFailures(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(unique, "Health verification and cleanup failed");
}

export async function withHealthStateReader(reader, work) {
  const errors = [];
  let result;
  try {
    result = await work();
  } catch (error) {
    errors.push(error);
  }
  try {
    await reader.closeAndWait();
  } catch (error) {
    errors.push(error);
  }
  throwHealthFailures(errors);
  return result;
}

const origin = (value) => {
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "Health private endpoint must be a loopback origin",
  );
  return url.origin;
};

export async function createHealthStateReader(
  config,
  {
    signal,
    secrets,
    initial,
    timeoutSignal = (ms) => AbortSignal.timeout(ms),
    preserve = (snapshot) =>
      writeEvidenceFile(
        config.evidence,
        "health-state.private.json",
        JSON.stringify(snapshot),
      ),
  } = {},
) {
  signal?.throwIfAborted();
  assert(Array.isArray(secrets));
  assert(initial?.agent_id);
  const boundary = config.healthPrivateAccess;
  assert(
    boundary &&
      typeof boundary.credentials === "string" &&
      isAbsolute(boundary.credentials),
  );
  const acp = origin(boundary.acp),
    identity = origin(boundary.identity);
  const dependencyRoot = new URL(
    "../../../services/agent-acp-service/package.json",
    import.meta.url,
  ).href;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "ajv/dist/2020.js"
        ? next(specifier, { ...context, parentURL: dependencyRoot })
        : next(specifier, context);
    },
  });
  let readPrivateExecutionState;
  try {
    ({ readPrivateExecutionState } =
      await import("../../support/private-acp-execution-state.mjs"));
  } finally {
    hook.deregister();
  }
  const paths = {
    "gateway-identity": "edge-gateway/tokens/identity-service",
    "agent-ui-acp": "agent-ui/tokens/agent-acp-service",
  };
  const service = serviceClient({
    identityEndpoint: identity,
    readCredential(grant) {
      assert(
        Object.hasOwn(paths, grant),
        "Health private grant is not allowed",
      );
      return readFileSync(join(boundary.credentials, paths[grant]), "utf8");
    },
  });
  const evidence = {
    initial: structuredClone(initial),
    reads: [],
    observations: [],
  };
  const active = new Set(),
    failures = [];
  let closing;
  const save = async () => {
    try {
      await preserve(structuredClone(evidence));
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  return {
    snapshot: () => structuredClone(evidence),
    read(phase, agentId, browser, principal, remainingMs) {
      const operation = (async () => {
        assert(!closing, "Health state reader is closing");
        assert(["unhealthy", "recovered", "restarted"].includes(phase));
        assert.equal(agentId, initial.agent_id);
        assert(
          Number.isFinite(remainingMs) && remainingMs >= 1,
          "Health observation deadline exhausted",
        );
        const requestSignal = AbortSignal.any([
          ...(signal ? [signal] : []),
          timeoutSignal(Math.min(15000, Math.floor(remainingMs))),
        ]);
        const receipts = [],
          errors = [];
        let state;
        try {
          state = await readPrivateExecutionState(agentId, browser, {
            endpoint: acp + "/rpc/agent-acp/get-agent-execution-state",
            principal,
            service,
            signal: requestSignal,
            receipts,
            secrets,
          });
        } catch (error) {
          errors.push(error);
        }
        evidence.reads.push(
          ...receipts.map((receipt) => ({ ...receipt, phase })),
        );
        try {
          await save();
        } catch (error) {
          errors.push(error);
        }
        if (requestSignal.aborted) errors.push(requestSignal.reason);
        throwHealthFailures(errors);
        return state;
      })();
      active.add(operation);
      operation.then(
        () => active.delete(operation),
        (error) => {
          active.delete(operation);
          failures.push(error);
        },
      );
      return operation;
    },
    async confirm(phase, agent) {
      assert(!closing, "Health state reader is closing");
      const index = evidence.reads.length - 1,
        receipt = evidence.reads[index];
      assert(receipt && receipt.phase === phase && receipt.status === 200);
      assertHealthProjection(
        initial,
        agent,
        JSON.parse(receipt.rawBody),
        phase,
      );
      assert(
        !evidence.observations.some((item) => item.receipt_index === index),
        "Health response reused across observations",
      );
      evidence.observations.push({
        phase,
        receipt_index: index,
        agent: structuredClone(agent),
      });
      await save();
    },
    closeAndWait() {
      return (closing ??= (async () => {
        await Promise.allSettled([...active]);
        try {
          await save();
        } catch {
          /* save retained the original error */
        }
        throwHealthFailures(failures);
      })());
    },
  };
}
