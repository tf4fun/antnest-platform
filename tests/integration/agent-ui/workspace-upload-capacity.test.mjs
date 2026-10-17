import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAuthFixture } from "../../../services/agent-ui/web/server/test/support/auth-fixture.mjs";
import { acpPromptRequestBytes } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { buildPromptBlocks } from "../../../services/agent-ui/web/src/lib/prompt.ts";
import {
  assertUploadOverlap,
  calibrate,
  startFixture,
} from "./capacity/process.mjs";
import { parseCapacityResponse } from "./capacity/response.mjs";

const fixture = await createAuthFixture({ built: true });
const { "Antnest-Service-Authorization": workloadAuthorization } =
  fixture.workloadHeaders();
const privateValues = new Set([
  workloadAuthorization.slice("Bearer ".length),
  ...readdirSync(`${fixture.directory}/tokens`).map((name) =>
    readFileSync(`${fixture.directory}/tokens/${name}`, "utf8"),
  ),
]);
const limit = 16 * 1024 * 1024;
const stamp = () => process.hrtime.bigint();
function request(url, headers, body) {
  let started;
  const response = new Promise((resolve, reject) => {
    started = httpRequest(
      url,
      {
        method: body === undefined ? "GET" : "POST",
        agent: false,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }),
        },
      },
      async (incoming) => {
        try {
          const chunks = [];
          let size = 0;
          for await (const bytes of incoming) {
            size += bytes.length;
            assert.ok(size < 128 * 1024, "bounded component response");
            chunks.push(bytes);
          }
          resolve({
            status: incoming.statusCode,
            body: parseCapacityResponse(Buffer.concat(chunks), privateValues),
          });
        } catch (error) {
          reject(error);
        }
      },
    );
    started.once("error", reject);
    started.setTimeout(5000, () =>
      started.destroy(new Error("Capacity client request timed out")),
    );
    started.end(body);
  });
  return { response, cancel: () => started.destroy() };
}

function upload(url, headers, body, heldBytes = 8192) {
  const pending = Promise.withResolvers();
  const outgoing = httpRequest(
    url,
    {
      method: "POST",
      agent: false,
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-length": body.length,
      },
    },
    async (incoming) => {
      try {
        const chunks = [];
        let size = 0;
        for await (const bytes of incoming) {
          size += bytes.length;
          assert.ok(size < 128 * 1024);
          chunks.push(bytes);
        }
        pending.resolve({
          status: incoming.statusCode,
          body: parseCapacityResponse(Buffer.concat(chunks), privateValues),
        });
      } catch (error) {
        pending.reject(error);
      }
    },
  );
  outgoing.on("error", pending.reject);
  // Attach a handler immediately so cleanup of a deliberately unfinished upload
  // cannot leave an unhandled rejection. The original promise still rejects.
  void pending.promise.catch(() => {});
  outgoing.setTimeout(10_000, () =>
    outgoing.destroy(new Error("Capacity upload timed out")),
  );
  outgoing.write(body.subarray(0, heldBytes));
  return {
    response: pending.promise,
    finish: () => outgoing.end(body.subarray(heldBytes)),
    cancel: () => outgoing.destroy(),
  };
}

for (const uploadCount of [1, 4]) {
  for (const phase of ["body-incomplete", "body-completion-and-parse"]) {
    for (const cancelPath of ["operation-cancel", "commands-stop"]) {
      test(
        `independent Bridge ${cancelPath} remains responsive during ${phase} with ${uploadCount} upload(s)`,
        { timeout: 30_000 },
        async (t) => {
          const cleanup = [];
          t.after(async () => {
            const results = [];
            for (const close of cleanup.reverse()) {
              try {
                await close();
              } catch (error) {
                results.push(error);
              }
            }
            if (results.length)
              throw new AggregateError(
                results,
                "Capacity fixture cleanup failed",
              );
          });
          // Use the shipped browser conversion and its per-file/count limits. These
          // are four valid UTF-8 files, not an oversized rejected JSON payload.
          const attachments = Array.from({ length: 4 }, (_, index) => {
            const name = `capacity-${index}.txt`;
            return {
              id: name,
              name,
              file: new File(["a".repeat(4 * 1024 * 1024 - 4096)], name, {
                type: "text/plain",
              }),
            };
          });
          const blocks = await buildPromptBlocks("", attachments, {});
          const aIntent = `upload-${phase}-${cancelPath}`;
          const bIntent = `held-${phase}-${cancelPath}`;
          const prompt = {
            sessionId: "session-a",
            intentId: aIntent,
            expectedAppendVersion: 0,
            prompt: blocks,
          };
          const envelopeBytes = acpPromptRequestBytes(prompt);
          assert.ok(envelopeBytes <= limit && envelopeBytes >= limit * 0.99);
          const body = Buffer.from(
            JSON.stringify({
              intentId: aIntent,
              expectedAppendVersion: 0,
              prompt: blocks,
            }),
          );
          const identities = ["a", "b"].map((suffix) => {
            const agentId = `agent-${suffix}`;
            const principalId = `user-${suffix}`;
            return {
              agentId,
              sessionId: `session-${suffix}`,
              publicScope: {
                organizationId: "capacity-org",
                principalId,
                agentId,
              },
              token: fixture.context({
                org: "capacity-org",
                sub: principalId,
                mbr: `membership-${suffix}`,
                sid: `login-${suffix}`,
                agt: agentId,
              }).token,
            };
          });
          for (const identity of identities) privateValues.add(identity.token);
          const upstream = await startFixture(
            {
              role: "upstream",
              identities,
              environment: fixture.securityEnvironment(),
              promptHashes: blocks.map((block) =>
                createHash("sha256").update(block.text).digest("hex"),
              ),
            },
            cleanup,
          );
          const bridge = await startFixture(
            {
              role: "bridge",
              upstream: upstream.origin,
              environment: fixture.securityEnvironment(),
              jwks: fixture.jwks,
            },
            cleanup,
          );
          assert.equal(
            new Set([process.pid, bridge.pid, upstream.pid]).size,
            3,
          );
          const headers = (index) => ({
            ...fixture.workloadHeaders(),
            "Antnest-Caller-Context": identities[index].token,
          });
          const base = (index) =>
            `${bridge.origin}/api/app/workspace/v1/agents/${identities[index].agentId}`;
          const session = (index) =>
            `${base(index)}/sessions/${identities[index].sessionId}`;
          const aView = await request(`${session(0)}/view`, headers(0))
            .response;
          const bView = await request(`${session(1)}/view`, headers(1))
            .response;
          assert.equal(aView.status, 200);
          assert.equal(bView.status, 200);
          const accepted = await request(
            `${session(1)}/prompts`,
            {
              ...headers(1),
              "if-match": bView.body.historyToken,
              "idempotency-key": bIntent,
            },
            JSON.stringify({
              intentId: bIntent,
              expectedAppendVersion: 0,
              prompt: [
                { type: "text", text: "Hold until this Run is cancelled" },
              ],
            }),
          ).response;
          assert.equal(accepted.status, 202);
          const held = await upstream.wait(
            "prompt-held",
            (value) => value.intentId === bIntent,
          );
          assert.equal(held.phase, "running");
          const operationURL = `${session(1)}/operations/${bIntent}`;
          const initial = await request(operationURL, headers(1)).response;
          assert.equal(initial.status, 200);
          assert.equal(initial.body.acceptance, "acp");
          assert.equal(initial.body.runId, held.runId);
          assert.equal(initial.body.phase, "running");
          const stale = await request(
            `${operationURL}/cancel`,
            headers(1),
            JSON.stringify({ expectedRunId: "wrong-run" }),
          ).response;
          assert.equal(stale.status, 409);
          assert.equal(
            upstream.receipts.some((value) => value.kind === "cancel-observed"),
            false,
          );
          const beforeClock = await calibrate(bridge);
          // Concurrent copies retain almost their entire legal body before EOF.
          // Repeating one browser intent must still dispatch exactly one ACP Run.
          const heldBytes = uploadCount === 1 ? 8192 : body.length - 1;
          const sending = Array.from({ length: uploadCount }, (_, index) =>
            upload(
              `${session(0)}/prompts`,
              {
                ...headers(0),
                "if-match": aView.body.historyToken,
                "idempotency-key": aIntent,
                "x-capacity-upload-id": `${aIntent}-${index}`,
                "x-capacity-held-bytes": String(heldBytes),
              },
              body,
              heldBytes,
            ),
          );
          cleanup.push(async () => {
            for (const item of sending) item.cancel();
            await Promise.allSettled(sending.map((item) => item.response));
          });
          const receiving = await Promise.all(
            sending.map((_, index) =>
              bridge.wait(
                "receive-held",
                (value) => value.uploadId === `${aIntent}-${index}`,
              ),
            ),
          );
          for (const receipt of receiving)
            assert.ok(receipt.bodyBytesAtLeast >= heldBytes);
          assert.equal(
            upstream.receipts.some(
              (value) =>
                value.kind === "prompt-held" && value.intentId === aIntent,
            ),
            false,
          );
          let eof;
          if (phase === "body-completion-and-parse") {
            for (const item of sending) item.finish();
            eof = await bridge.wait(
              "body-eof",
              (value) => value.intentId === aIntent,
            );
          } else
            assert.equal(
              bridge.receipts.some(
                (value) =>
                  value.kind === "body-eof" && value.intentId === aIntent,
              ),
              false,
            );
          const cancelBody =
            cancelPath === "operation-cancel"
              ? { expectedRunId: held.runId }
              : {
                  text: "/stop",
                  sessionId: held.sessionId,
                  operationId: bIntent,
                  expectedRunId: held.runId,
                };
          const serializedCancel = JSON.stringify(cancelBody);
          const cancelSent = stamp();
          const cancellation = await request(
            cancelPath === "operation-cancel"
              ? `${operationURL}/cancel`
              : `${base(1)}/commands`,
            headers(1),
            serializedCancel,
          ).response;
          assert.equal(cancellation.status, 200);
          let terminal;
          const observationDeadline = stamp() + 3_000_000_000n;
          do {
            terminal = await request(operationURL, headers(1)).response;
            if (terminal.body.phase === "cancelled") break;
            await delay(5);
          } while (stamp() < observationDeadline);
          assert.equal(terminal.status, 200);
          assert.equal(terminal.body.phase, "cancelled");
          assert.equal(terminal.body.runId, held.runId);
          assert.equal(terminal.body.stopReason, "cancelled");
          const released = await upstream.wait(
            "held-work-released",
            (value) => value.intentId === bIntent,
          );
          assert.equal(released.cancellations, 1);
          assert.equal(released.runId, held.runId);
          assert.equal(released.principalId, "user-b");
          assert.equal(released.agentId, "agent-b");
          const observed = stamp();
          if (phase === "body-incomplete") {
            assert.equal(
              bridge.receipts.some(
                (value) =>
                  value.kind === "body-eof" && value.intentId === aIntent,
              ),
              false,
            );
            for (const item of sending) item.finish();
          }
          const aResponses = await Promise.all(
            sending.map((item) => item.response),
          );
          assert.ok(aResponses.some((response) => response.status === 202));
          for (const response of aResponses) {
            if (response.status !== 202) {
              assert.equal(response.status, 409);
              assert.equal(response.body.code, "stale_history");
            }
          }
          const aHeld = await upstream.wait(
            "prompt-held",
            (value) => value.intentId === aIntent,
          );
          assert.equal(aHeld.promptCount, 1);
          eof ??= await bridge.wait(
            "body-eof",
            (value) => value.intentId === aIntent,
          );
          const handler = await bridge.wait(
            "handler-enter",
            (value) => value.uploadId === eof.uploadId,
          );
          const uploads = await Promise.all(
            sending.map(async (_, index) => {
              const uploadId = `${aIntent}-${index}`;
              return {
                receiving: receiving[index],
                receivingObservedNs: bridge
                  .observedAt(receiving[index])
                  .toString(),
                eof: await bridge.wait(
                  "body-eof",
                  (value) => value.uploadId === uploadId,
                ),
                handler: await bridge.wait(
                  "handler-enter",
                  (value) => value.uploadId === uploadId,
                ),
                response: {
                  status: aResponses[index].status,
                  code: aResponses[index].body.code,
                },
              };
            }),
          );
          const serialized = await bridge.wait(
            "prompt-serialized",
            (value) => value.intentId === aIntent,
          );
          const afterClock = await calibrate(bridge);
          // Actual IPC receipt establishes that cancellation follows the upload
          // boundary. The union's upper bound still proves it precedes completion.
          const high =
            BigInt(beforeClock.high) > BigInt(afterClock.high)
              ? BigInt(beforeClock.high)
              : BigInt(afterClock.high);
          const cancelLatest = cancelSent + high;
          const eofObservedNs = bridge.observedAt(eof);
          t.diagnostic(
            JSON.stringify({
              scope: "capacity overlap observation",
              phase,
              cancelPath,
              uploadCount,
              uploads,
              eof,
              handler,
              clientEofObservedNs: eofObservedNs.toString(),
              clientCancelSentNs: cancelSent.toString(),
              childCancelLatestNs: cancelLatest.toString(),
              beforeClock,
              afterClock,
            }),
          );
          if (phase === "body-completion-and-parse") {
            assertUploadOverlap({
              observedAt: eofObservedNs,
              cancelSent,
              cancelLatest,
              completedAt: BigInt(handler.ns),
            });
          } else {
            for (const item of uploads) {
              assertUploadOverlap({
                observedAt: bridge.observedAt(item.receiving),
                cancelSent,
                cancelLatest,
                completedAt: BigInt(item.eof.ns),
              });
            }
          }
          assert.ok(BigInt(handler.ns) < BigInt(serialized.ns));
          const cancelMs = Number(observed - cancelSent) / 1e6;
          const aCancel = await request(
            `${session(0)}/operations/${aIntent}/cancel`,
            headers(0),
            JSON.stringify({ expectedRunId: aHeld.runId }),
          ).response;
          assert.equal(aCancel.status, 200);
          await upstream.wait(
            "held-work-released",
            (value) => value.intentId === aIntent,
          );
          await bridge.stop();
          await upstream.stop();
          const summary = await upstream.wait("fixture-summary");
          assert.equal(summary.states.length, 2);
          for (const state of summary.states) {
            assert.equal(state.promptAttempts, 1);
            assert.equal(state.cancelAttempts, 1);
            assert.equal(state.cancellations, 1);
            assert.equal(state.phase, "cancelled");
          }
          t.diagnostic(
            JSON.stringify({
              scope:
                "real Bridge / ACP protocol component; execution double, not Docker Runtime proof",
              phase,
              cancelPath,
              uploadCount,
              heldBodyBytes: heldBytes * uploadCount,
              uploads,
              clientPid: process.pid,
              bridgePid: bridge.pid,
              upstreamPid: upstream.pid,
              envelopeBytes,
              limit,
              attachmentBytes: attachments.map((item) => item.file.size),
              receiving,
              eof,
              handler,
              serialized,
              held,
              released,
              summary,
              clientCancelSentNs: cancelSent.toString(),
              clientEofObservedNs: eofObservedNs.toString(),
              clientTerminalObservedNs: observed.toString(),
              beforeClock,
              afterClock,
              cancelMs,
            }),
          );
          assert.ok(
            cancelMs <= 1000,
            `same-operation cancellation took ${cancelMs.toFixed(1)} ms`,
          );
        },
      );
    }
  }
}
