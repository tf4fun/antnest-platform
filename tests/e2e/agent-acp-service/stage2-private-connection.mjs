import assert from "node:assert/strict";
import { inspect } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { openBrowserPrivateACP } from "../identity-closeout/private-acp-browser.mjs";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import { assertPromptEvidence } from "./stage2-acp-evidence.mjs";
import { assertAdmissionError } from "../../support/acp-errors.mjs";

function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Stage2 request, archive or cleanup failed",
    );
}

export async function openStage2Connection(agentId, browser, options) {
  assert.equal(
    typeof options.preserve,
    "function",
    "Stage2 connection archive required",
  );
  const transport = await openBrowserPrivateACP(2, agentId, browser, {
    ...options,
    captureRawFrames: true,
    requestPermission: ({ params }) => {
      const option = params.options.find((item) => item.kind === "allow_once");
      assert(option, "Stage2 tool requires its original one-use permission");
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    },
  });
  const records = [],
    pending = new Set(),
    activeKeys = new Set(),
    evidenceErrors = [];
  const claimed = new Set();
  let closing,
    closed = false,
    archiving = Promise.resolve();
  function identity(actual, method, inputSessionID) {
    assert.equal(actual?.method, method, "Stage2 actual wire method missing");
    assert.equal(
      actual.sessionId ?? null,
      inputSessionID,
      "Stage2 foreign wire Session",
    );
    assert(typeof actual.requestId === "string" && actual.requestId.length > 0);
    assert(!claimed.has(actual.requestId), "duplicate Stage2 wire ID");
    claimed.add(actual.requestId);
    return {
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: 2,
      agentId,
      connectionTraceID: transport.connectionTraceID,
      clientSpanID: transport.clientSpanID,
      method,
      requestId: actual.requestId,
      inputSessionID,
    };
  }
  let initialization;
  const snapshot = () =>
    structuredClone({
      version: 2,
      agentId,
      connectionTraceID: transport.connectionTraceID,
      clientSpanID: transport.clientSpanID,
      closed,
      initialization,
      evidence: records,
      requests: transport.requests,
      raw_frames: transport.rawFrames,
      updates: transport.updates,
      evidence_errors: evidenceErrors.map((error) => inspect(error)),
    });
  const archive = () => {
    const captured = snapshot();
    const task = archiving.then(() => options.preserve(captured));
    archiving = task.catch((error) => {
      evidenceErrors.push(error);
    });
    return task;
  };
  const client = Object.create(transport);
  client.snapshot = snapshot;
  client.closeAndWait = () => {
    if (!closing)
      closing = Promise.resolve().then(async () => {
        options.signal?.removeEventListener("abort", abort);
        const errors = [];
        try {
          await transport.closeAndWait();
          closed = true;
        } catch (error) {
          errors.push(error);
        }
        while (pending.size) await Promise.allSettled([...pending]);
        try {
          checkPrivateACPConnection(snapshot());
        } catch (error) {
          errors.push(error);
        }
        try {
          await archive();
        } catch (error) {
          errors.push(error);
        }
        errors.push(...evidenceErrors);
        fail(errors);
        return snapshot();
      });
    void closing.catch(() => {});
    return closing;
  };
  client.close = client.closeAndWait;
  const abort = () => {
    void client.closeAndWait().catch(() => {});
  };
  client.request = (name, params, timeout = 15000, details = {}) => {
    const key = JSON.stringify([name, params.sessionId ?? null]);
    if (closing || options.signal?.aborted)
      return Promise.reject(
        options.signal?.reason ?? new Error("Stage2 connection is closing"),
      );
    if (activeKeys.has(key))
      return Promise.reject(
        new Error("ambiguous Stage2 same-session request overlap"),
      );
    assert(["new", "load", "prompt"].includes(name));
    for (const field of Object.keys(details))
      assert(["kind", "phase", "toolName", "rejection"].includes(field));
    const input = structuredClone(params),
      method = "session/" + name;
    const row = {
      kind: "request",
      ...structuredClone(details),
      method,
      requestParams: input,
    };
    records.push(row);
    activeKeys.add(key);
    const before = new Set(transport.requests.map((item) => item.requestId));
    let outcome;
    const result = Promise.resolve()
      .then(() => transport.request(name, input, timeout))
      .then(
        (value) => (outcome = { value }),
        (error) => (outcome = { error }),
      );
    const task = (async () => {
      const errors = [];
      try {
        // Bind while dispatch is in flight. A held Prompt must not consume the
        // later busy requests merely because they completed before its reply.
        const deadline = Date.now() + 5000;
        let candidates;
        do {
          candidates = transport.requests.filter(
            (item) =>
              !before.has(item.requestId) &&
              item.method === method &&
              (item.sessionId ?? null) === (input.sessionId ?? null),
          );
          if (candidates.length || outcome) break;
          await delay(1);
        } while (Date.now() < deadline);
        assert.equal(
          candidates.length,
          1,
          "missing or ambiguous Stage2 wire request",
        );
        Object.assign(
          row,
          identity(candidates[0], method, input.sessionId ?? null),
        );
        await archive();
      } catch (error) {
        evidenceErrors.push(error);
        errors.push(error);
      }
      const settled = await result;
      row.outcome = Object.hasOwn(settled, "error") ? "failed" : "succeeded";
      row.sessionId = input.sessionId ?? settled.value?.sessionId;
      if (row.outcome === "succeeded") {
        row.requestResult = structuredClone(settled.value);
        row.requestReceipt = structuredClone({
          requestId: row.requestId,
          params: input,
          result: settled.value,
        });
      } else {
        const error = settled.error;
        errors.unshift(error);
        row.failure = inspect(error, { depth: 8 });
        if (
          typeof error?.code === "number" &&
          typeof error?.data?.code === "string" &&
          typeof error?.data?.retryable === "boolean"
        )
          row.rejectionReceipt = {
            rpcCode: error.code,
            code: error.data.code,
            retryable: error.data.retryable,
          };
      }
      try {
        await archive();
      } catch (error) {
        errors.push(error);
      }
      if (options.signal?.aborted) errors.push(options.signal.reason);
      fail(errors);
      return settled.value;
    })();
    pending.add(task);
    void task.then(
      () => {
        pending.delete(task);
        activeKeys.delete(key);
      },
      () => {
        pending.delete(task);
        activeKeys.delete(key);
      },
    );
    return task;
  };
  client.newSession = () =>
    client.request("new", { cwd: "/workspace", mcpServers: [] });
  client.denied = (sessionId, codes = ["access_denied", "agent_unavailable"]) =>
    assert.rejects(
      client.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "This prompt must not be admitted." }],
      }),
      (error) => {
        assert(codes.includes(error?.data?.code), "unexpected Stage2 denial");
        assertAdmissionError(error, error.data.code);
        return true;
      },
    );
  client.prompt = (sessionId, { timeout = 180000 } = {}) => {
    if (closing || options.signal?.aborted)
      return Promise.reject(
        options.signal?.reason ?? new Error("Stage2 connection is closing"),
      );
    const start = transport.updates.length;
    const index = records.length;
    const dispatched = client.request("prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "Create the Stage 2 acceptance evidence file." },
      ],
    });
    const row = records[index];
    const task = (async () => {
      const errors = [];
      let result;
      try {
        const ack = await dispatched;
        const deadline = Date.now() + timeout;
        while (true) {
          options.signal?.throwIfAborted();
          if (closing || transport.closeCode !== undefined)
            throw new Error(
              "Stage2 connection closed before Prompt completion",
            );
          const events = transport.updates
            .slice(start)
            .filter((item) => item.sessionId === sessionId);
          if (
            events.some(
              ({ update }) =>
                update.sessionUpdate === "state_update" &&
                update.state === "idle",
            )
          ) {
            const message = assertPromptEvidence(ack, events, sessionId);
            row.completion = structuredClone({ ack, events, message });
            result = { session_id: sessionId, message };
            break;
          }
          assert(Date.now() < deadline, "Stage2 Prompt completion timed out");
          await delay(10);
        }
      } catch (error) {
        errors.push(error);
        if (row) row.completion_failure = inspect(error, { depth: 8 });
      }
      try {
        await archive();
      } catch (error) {
        errors.push(error);
      }
      fail(errors);
      return result;
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  try {
    assert.equal(
      transport.requests.length,
      1,
      "one Stage2 initialization required",
    );
    initialization = {
      ...identity(transport.requests[0], "initialize", null),
      kind: "request",
      outcome: "succeeded",
      initializationResult: structuredClone(transport.initializationResult),
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    options.signal?.throwIfAborted();
    await archive();
    options.signal?.throwIfAborted();
    return client;
  } catch (error) {
    const errors = [error];
    if (options.signal?.aborted) errors.push(options.signal.reason);
    try {
      await client.closeAndWait();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    fail(errors);
  }
}
