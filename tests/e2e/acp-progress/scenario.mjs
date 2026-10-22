import assert from "node:assert/strict";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";
import { transcript } from "../acp-commands/evidence.mjs";
import {
  assertEarly,
  assertTerminal,
  toolUpdates,
  terminalStatus,
  previewReceived,
} from "./evidence.mjs";

const setup = { cwd: "/workspace", mcpServers: [] };

function sessionFrames(client, sessionId) {
  assert(
    client.updates.every((frame) => frame.sessionId === sessionId),
    "foreign Progress Session update",
  );
  return client.updates;
}

// Keep the original closed connector: only it can issue terminal notification
// receipts that authorize cancellation Trace correlation.
export function createProgressScenario({
  connect,
  replay,
  until,
  outcomes,
  onConnectionClosed = () => {},
  diagnose,
  now = () => performance.now(),
}) {
  return async (version, source, ending, agent, gate) => {
    assert([1, 2].includes(version));
    assert(["bash", "managed"].includes(source));
    assert(["success", "failure", "cancel"].includes(ending));
    const phase = `v${version}-${source}-${ending}`;
    const connections = [],
      errors = [];
    let client,
      original,
      sessionId,
      toolCallId,
      pending,
      responseHandled = false;
    const remember = (error) => {
      if (!errors.includes(error)) errors.push(error);
    };
    async function open(role) {
      const next = await connect(version, agent);
      assert(
        !connections.some((row) => row.client === next),
        "fresh Progress connection required",
      );
      connections.push({ role, client: next });
      assert.equal(next.boundary, "private-acp");
      assert.equal(next.transport, "websocket");
      assert.equal(next.version, version);
      assert.equal(next.agentId, agent);
      return next;
    }
    function close(connection, deliberate = false) {
      const entry = connections.find((row) => row.client === connection);
      return (entry.closing ??= (async () => {
        const failures = new Set();
        if (deliberate) {
          try {
            await connection.disconnectForReplay();
          } catch (error) {
            failures.add(error);
          }
        }
        // A deliberate-disconnect precondition may fail before it closes.
        // Always perform the actual idempotent close/join independently.
        let closed = false;
        try {
          await connection.closeAndWait();
          closed = true;
        } catch (error) {
          failures.add(error);
        }
        if (closed) {
          try {
            if (sessionId !== undefined) sessionFrames(connection, sessionId);
          } catch (error) {
            failures.add(error);
          }
          // Preserve the original inventory even when its frames are invalid.
          try {
            await onConnectionClosed({
              phase,
              version,
              source,
              ending,
              agentId: agent,
              sessionId,
              role: entry.role,
              client: connection,
            });
          } catch (error) {
            failures.add(error);
          }
        }
        if (failures.size === 1) throw [...failures][0];
        if (failures.size)
          throw new AggregateError(
            [...failures],
            "Progress close and inventory failed",
          );
      })());
    }
    async function promptResponse(disconnected = false) {
      const response = await pending;
      responseHandled = true;
      if (response.error) {
        if (!(
          disconnected &&
          version === 1 &&
          original.lastRequest.closedBeforeResponse === true
        ))
          throw response.error;
      } else if (disconnected && version === 1) {
        assert.fail(
          "v1 held prompt completed before deliberate replay disconnect",
        );
      } else if (version === 1) {
        assert.deepEqual(response.result, {
          stopReason: ending === "cancel" ? "cancelled" : "end_turn",
        });
      } else {
        assert(
          typeof response.result?.messageId === "string" &&
            response.result.messageId.length > 0,
          "v2 prompt admission missing message identity",
        );
      }
    }
    try {
      client = original = await open("prompt");
      ({ sessionId } = await client.request("new", setup));
      assert(typeof sessionId === "string" && sessionId.length > 0);
      sessionFrames(client, sessionId);
      client.updates.length = 0;
      pending = client
        .request(
          "prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: phase }],
          },
          120000,
        )
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
      const marker =
        source === "bash" ? `${phase}-partial` : "progress-payload-canary";
      await until(
        () => previewReceived(sessionFrames(client, sessionId), marker),
        `${phase} early progress`,
      );
      toolCallId = assertEarly(client.updates, marker);
      if (ending === "success") {
        await close(client, true);
        await promptResponse(true);
        assert.equal(assertEarly(client.updates, marker), toolCallId);
        const prefix = structuredClone(toolUpdates(client.updates));
        client = await open("live-replay");
        await replay(client, version, sessionId);
        assert.equal(
          assertEarly(sessionFrames(client, sessionId), marker),
          toolCallId,
        );
        assert.deepEqual(toolUpdates(client.updates), prefix);
      }
      if (ending === "cancel") {
        await gate.alive(phase, source);
        const cancelAt = Date.now();
        const started = now();
        try {
          await client.notify("cancel", { sessionId });
          const remaining = 10000 - (now() - started);
          assert(
            remaining > 0 && remaining <= 10000,
            `${phase} process cancellation deadline`,
          );
          await until(
            () => {
              const timeoutMS = 10000 - (now() - started);
              assert(
                timeoutMS > 0 && timeoutMS <= 10000,
                `${phase} process cancellation deadline`,
              );
              return gate.stopped(phase, source, { timeoutMS });
            },
            `${phase} process cancellation`,
            remaining,
          );
          const elapsed = now() - started;
          assert(
            elapsed >= 0 && elapsed <= 10000,
            `${phase} process cancellation deadline`,
          );
        } catch (error) {
          remember(error);
          try {
            await close(client);
          } catch (failure) {
            remember(failure);
          }
          if (diagnose) {
            try {
              await diagnose({
                phase,
                version,
                source,
                agentId: agent,
                sessionId,
                cancelAt,
                cancelStarted: started,
                client,
                frames: structuredClone(client.updates),
                stopped: (options) => gate.stopped(phase, source, options),
              });
            } catch (failure) {
              remember(failure);
            }
          }
          throw error;
        }
      } else await gate.release(phase);
      const status = terminalStatus(version, source, ending);
      await until(
        () =>
          toolUpdates(sessionFrames(client, sessionId)).at(-1)?.status ===
          status,
        `${phase} terminal`,
      );
      if (ending !== "success") await promptResponse();
      if (version === 2) {
        await until(
          () =>
            sessionFrames(client, sessionId).some(
              ({ update }) =>
                update.sessionUpdate === "state_update" &&
                update.state === "idle" &&
                update.stopReason ===
                  (ending === "cancel" ? "_unresolved" : "end_turn"),
            ),
          `${phase} terminal state`,
        );
      }
      if (ending !== "cancel")
        await until(
          () =>
            transcript(sessionFrames(client, sessionId), sessionId).some(
              ({ role, content }) =>
                role === "assistant" &&
                content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("") === `${phase} verified`,
            ),
          `${phase} verified response`,
        );
      assertTerminal(client.updates, toolCallId, status);
      if (source === "managed")
        assert(
          !JSON.stringify(toolUpdates(client.updates).at(-1).content).includes(
            "progress-payload-canary",
          ),
        );
      await close(client);
      // Snapshot only after the real close has drained late frames.
      assertTerminal(client.updates, toolCallId, status);
      const before = structuredClone(toolUpdates(client.updates));
      client = await open("terminal-replay");
      await replay(client, version, sessionId);
      assert.deepEqual(toolUpdates(sessionFrames(client, sessionId)), before);
      if (ending === "cancel") {
        let rejection;
        try {
          await client.request("prompt", {
            sessionId,
            prompt: [{ type: "text", text: "must remain blocked" }],
          });
        } catch (error) {
          rejection = error;
        }
        assert(rejection, "Runtime barrier did not reject the next prompt");
        assertAdmissionError(rejection, "runtime_barrier_required");
        const expected = admissionErrorReceipt("runtime_barrier_required");
        assert.deepEqual(client.lastRequest.rejectionReceipt, {
          rpcCode: expected.code,
          ...expected.data,
        });
      }
      await close(client);
      assert.deepEqual(toolUpdates(client.updates), before);
    } catch (error) {
      remember(error);
    } finally {
      for (const entry of connections) {
        try {
          await close(entry.client);
        } catch (error) {
          remember(error);
        }
      }
      if (pending && !responseHandled) {
        const response = await pending;
        if (response.error && !original.isLocalCloseError(response.error))
          remember(response.error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(
        errors,
        "Progress business and connection cleanup failed",
      );
    outcomes.push({
      phase,
      early_progress: true,
      replay: true,
      terminal: terminalStatus(version, source, ending),
      ...(ending === "cancel" ? { actual_execution_stopped: true } : {}),
    });
    return { phase, sessionId, toolCallId };
  };
}
