import assert from "node:assert/strict";
import { terminalStatus } from "./evidence.mjs";

// Controlled business producer for the scenario unit tests. The separate
// connection suite uses real SDK peers; neither suite replaces Runtime E2E.
export function progressScenarioFixture(version, source, ending, options = {}) {
  const phase = `v${version}-${source}-${ending}`;
  const sessionId = "progress-session";
  const clients = [],
    history = [],
    events = [],
    receipts = [],
    outcomes = [];
  const prompt = Promise.withResolvers();
  // v2 admission is immediate; the producer's completion is still controlled.
  void prompt.promise.catch(() => {});
  let elapsed = 0;
  let active,
    terminal = false,
    issued = 0;
  const frame = (update) => ({ sessionId, update });
  const emit = (value) => {
    history.push(structuredClone(value));
    for (const client of clients)
      if (client.subscribed && !client.closing)
        client.updates.push(structuredClone(value));
  };
  function finish() {
    if (terminal) return;
    terminal = true;
    emit(
      frame({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool",
        status: terminalStatus(version, source, ending),
        content: [],
      }),
    );
    if (options.duplicateTerminal) emit(history.at(-1));
    if (ending !== "cancel") {
      const chunks = options.splitResponse
        ? [phase, " verified"]
        : [`${phase} verified`];
      for (const text of chunks)
        emit(
          frame({
            sessionUpdate: options.wholeMessage
              ? "agent_message"
              : "agent_message_chunk",
            messageId: "answer",
            content: options.wholeMessage
              ? [{ type: "text", text }]
              : { type: "text", text },
          }),
        );
    }
    if (version === 2)
      emit(
        frame({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: ending === "cancel" ? "_unresolved" : "end_turn",
        }),
      );
    prompt.resolve({
      stopReason: ending === "cancel" ? "cancelled" : "end_turn",
    });
  }
  async function connect() {
    if (options.connectFailure && clients.length === options.connectFailure.at)
      throw options.connectFailure.error;
    if (clients.length)
      assert(
        clients.at(-1).closed,
        "previous connection must be joined before reconnect",
      );
    const index = clients.length;
    const notifications = [];
    let closing;
    const client = {
      boundary: options.boundary ?? "private-acp",
      transport: "websocket",
      version,
      agentId: "agent",
      updates: [],
      requestEvidence: [],
      notifications,
      initializationRequest: {
        method: "initialize",
        requestId: `${index}:init`,
      },
      isLocalCloseError: (error) => error === client.closeError,
      async request(name, params) {
        assert(!client.closing, "no request after close");
        const row = {
          method: `session/${name}`,
          requestId: String(++issued),
          sessionId,
          outcome: "succeeded",
        };
        client.requestEvidence.push(row);
        client.lastRequest = row;
        if (name === "new") return { sessionId };
        assert.equal(params.sessionId, sessionId);
        if (name === "load" || name === "resume") {
          client.subscribed = true;
          client.updates.push(...structuredClone(history));
          if (options.corruptReplay)
            client.updates[0].update.toolCallId = "foreign";
          events.push("replay");
          return {};
        }
        assert.equal(name, "prompt");
        if (terminal) {
          const error = Object.assign(new Error("Runtime barrier"), {
            code: -32020,
            data: {
              code: "runtime_barrier_required",
              retryable: options.retryable ?? false,
            },
          });
          Object.assign(row, {
            outcome: "rejected",
            rejection: error.data.code,
            rejectionReceipt: { rpcCode: error.code, ...error.data },
          });
          throw error;
        }
        client.subscribed = true;
        active = client;
        emit(
          frame({
            sessionUpdate: "tool_call",
            toolCallId: "tool",
            status: "in_progress",
          }),
        );
        emit({
          sessionId: options.foreignSession ? "foreign" : sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool",
            status: "in_progress",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text:
                    source === "bash"
                      ? `${phase}-partial`
                      : "progress-payload-canary",
                },
              },
            ],
          },
        });
        if (options.promptFailure) {
          row.outcome = "failed";
          throw options.promptFailure;
        }
        if (version === 2) return { messageId: "message" };
        try {
          return await prompt.promise;
        } catch (error) {
          row.outcome = "failed";
          throw error;
        }
      },
      async notify(name, params) {
        assert.equal(name, "cancel");
        assert.equal(params.sessionId, sessionId);
        events.push("cancel");
        elapsed += options.notifyElapsed ?? 0;
        notifications.push(
          Object.freeze({ method: "session/cancel", sessionId }),
        );
      },
      closeAndWait() {
        if (!closing) {
          client.closing = true;
          client.closeError = new Error("original local close");
          if (active === client && !terminal) prompt.reject(client.closeError);
          closing = Promise.resolve().then(async () => {
            await Promise.resolve();
            client.closed = true;
            events.push(`closed:${index}`);
            if (options.latePreview && index === 0) {
              const last = frame({
                sessionUpdate: "tool_call_update",
                toolCallId: "tool",
                status: "in_progress",
                content: [
                  {
                    type: "content",
                    content: { type: "text", text: "last preview before EOF" },
                  },
                ],
              });
              history.push(structuredClone(last));
              client.updates.push(last);
            }
            if (options.lateForeign && index === 0)
              client.updates.push({ sessionId: "foreign", update: {} });
            if (options.closeFailure?.at === index)
              throw options.closeFailure.error;
          });
          void closing.catch(() => {});
        }
        return closing;
      },
      close() {
        void client.closeAndWait();
      },
      async disconnectForReplay() {
        events.push("disconnect-for-replay");
        if (options.disconnectFailure) throw options.disconnectFailure;
        if (version === 1 && !options.promptFailure)
          client.lastRequest.closedBeforeResponse = true;
        return client.closeAndWait();
      },
    };
    clients.push(client);
    return client;
  }
  const gate = {
    async release() {
      if (options.gateFailure) throw options.gateFailure;
      events.push("release");
      finish();
    },
    async alive() {
      assert(!terminal);
      events.push("alive");
    },
    async stopped() {
      events.push("stopped");
      elapsed += options.probeElapsed ?? 0;
      if (options.neverStopped) return false;
      finish();
      return true;
    },
  };
  return {
    phase,
    clients,
    events,
    receipts,
    outcomes,
    gate,
    dependencies: {
      now: () => elapsed,
      connect,
      outcomes,
      replay: (client, v, session) =>
        client.request(v === 1 ? "load" : "resume", { sessionId: session }),
      until: async (check, label, timeout) => {
        events.push({ label, timeout });
        assert(await check(), `Timed out: ${label}`);
      },
      onConnectionClosed: async (receipt) => {
        assert(receipt.client.closed, "receipt before joined close");
        receipts.push(receipt);
        if (options.receiptFailure) throw options.receiptFailure;
      },
      diagnose: async () => {
        events.push("diagnose");
        if (options.diagnosticFailure) throw options.diagnosticFailure;
      },
    },
  };
}
