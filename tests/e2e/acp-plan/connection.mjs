import assert from "node:assert/strict";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
} from "../acp-commands/connection.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { caseFor } from "./model.mjs";
import { assertPlanEvents, planUpdates } from "./evidence.mjs";

function identity(client, actual, method, sessionId, { phase, denial } = {}) {
  assert.equal(client.boundary, "private-acp");
  assert.equal(client.transport, "websocket");
  assert([1, 2].includes(client.version));
  assert.equal(actual?.method, method, "actual Plan SDK request missing");
  assert(typeof actual.requestId === "string" && actual.requestId.length > 0);
  const wire = client.requests.filter(
    (item) => item.requestId === actual.requestId,
  );
  assert.equal(wire.length, 1, "duplicate or missing Plan wire request");
  assert.equal(wire[0].method, method);
  assert.equal(wire[0], client.requests.at(-1), "stale Plan request receipt");
  const inputSessionID = wire[0].sessionId ?? null;
  if (Object.hasOwn(actual, "inputSessionID"))
    assert.equal(actual.inputSessionID, inputSessionID);
  if (denial) {
    const expected = admissionErrorReceipt(denial);
    assert.deepEqual(actual.rejectionReceipt, {
      rpcCode: expected.code,
      ...expected.data,
    });
  } else
    assert.equal(
      actual.rejectionReceipt,
      undefined,
      "denied request cannot be recorded as success",
    );
  if (
    method === "initialize" ||
    (method === "session/new" && denial === "access_denied")
  ) {
    assert.equal(sessionId, undefined);
    assert.equal(inputSessionID, null);
  } else {
    assert(typeof sessionId === "string" && sessionId.trim().length > 0);
    if (method === "session/new") assert.equal(inputSessionID, null);
    else {
      assert(typeof inputSessionID === "string" && inputSessionID.length > 0);
      if (method === "session/fork" && !denial)
        assert.notEqual(sessionId, inputSessionID);
      else assert.equal(sessionId, inputSessionID);
    }
  }
  if (phase !== undefined) {
    assert.equal(method, "session/prompt");
    assert(phase.startsWith(`v${client.version}-`));
    caseFor(phase);
  }
  return structuredClone({
    ...actual,
    boundary: client.boundary,
    transport: client.transport,
    protocolVersion: client.version,
    agentId: client.agentId,
    connectionTraceID: client.connectionTraceID,
    clientSpanID: client.clientSpanID,
    inputSessionID,
    sessionId,
    ...(phase === undefined ? {} : { phase }),
    ...(denial === undefined ? {} : { denial }),
  });
}

export function planRequestIdentity(client, method, sessionId, details) {
  return identity(client, client.lastRequest, method, sessionId, details);
}

export async function openPrivatePlanConnection(
  version,
  agentId,
  browser,
  options,
) {
  assert([1, 2].includes(version));
  const client = await openPrivateCommandConnection(
    { version },
    agentId,
    browser,
    options,
  );
  try {
    assert.equal(client.requests.length, 1, "one actual initialize required");
    client.initializationRequest = identity(
      client,
      client.requests[0],
      "initialize",
      undefined,
    );
    return client;
  } catch (error) {
    return withPrivateCommandConnection(client, [], async () => {
      throw error;
    });
  }
}

export async function runPlanPrompt(
  client,
  version,
  sessionId,
  phase,
  { release, wait = until },
) {
  assert.equal(version, client.version);
  assert(phase.startsWith(`v${version}-`));
  const expected = caseFor(phase);
  assert.equal(typeof release, "function");
  client.updates.length = 0;
  let completed = false;
  const observed = Promise.resolve()
    .then(() =>
      client.request(
        "prompt",
        { sessionId, prompt: [{ type: "text", text: phase }] },
        120000,
      ),
    )
    .then(
      (response) => {
        completed = version === 1;
        return { response };
      },
      (error) => ({ error }),
    );
  try {
    if (expected.plans.length) {
      await wait(
        () => planUpdates(client.updates).length === expected.plans.length,
        "early plan",
      );
      assert(!completed, "v1 Prompt ended before the plan gate");
      assert(
        !client.updates.some(({ update }) =>
          ["agent_message", "agent_message_chunk"].includes(
            update.sessionUpdate,
          ),
        ),
        "final response preceded gate release",
      );
      assert(
        !client.updates.some(
          ({ update }) =>
            update.sessionUpdate === "state_update" && update.state === "idle",
        ),
        "v2 ended before plan gate release",
      );
      await release(phase);
    }
    const result = await observed;
    if (result.error) throw result.error;
    if (version === 1) assert.equal(result.response.stopReason, "end_turn");
    else
      await wait(
        () =>
          client.updates.some(
            ({ update }) =>
              update.sessionUpdate === "state_update" &&
              update.state === "idle" &&
              update.stopReason === "end_turn",
          ),
        "v2 Run idle",
      );
    assert(
      client.updates.every((frame) => frame.sessionId === sessionId),
      "foreign live Plan Session",
    );
    return {
      response: result.response,
      request: planRequestIdentity(client, "session/prompt", sessionId, {
        phase,
      }),
      outcome: assertPlanEvents(version, phase, client.updates),
      updates: structuredClone(client.updates),
    };
  } catch (error) {
    const errors = [error];
    try {
      await client.closeAndWait();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    const joined = await observed;
    if (joined.error && !errors.includes(joined.error))
      errors.push(joined.error);
    if (errors.length === 1) throw error;
    throw new AggregateError(
      errors,
      "Plan gate, original Prompt or connection cleanup failed",
      { cause: error },
    );
  }
}
