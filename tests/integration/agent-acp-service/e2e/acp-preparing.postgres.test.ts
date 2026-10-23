import { randomUUID } from "node:crypto";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import type { ModelResult } from "../../../../services/agent-acp-service/src/ports/model.js";
import { closedExecutionAgent } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { identityHeaders } from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { assertAdmissionError } from "../../../support/acp-errors.mjs";
import type { ProtocolVersion } from "../support/acp-wire-client.js";
import {
  boundaryState,
  startBoundaryApplication,
} from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const answer: ModelResult = {
  kind: "message",
  content: [{ type: "text", text: "prepared execution completed" }],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
};
type Application = Awaited<ReturnType<typeof startBoundaryApplication>>;

describe.skipIf(databaseUrl === undefined)(
  "ACP preparing admission with real PostgreSQL and protocol connections",
  () => {
    let pool: Pool;
    let app: Application | undefined;
    let closing: Promise<void> | undefined;
    const streams: Array<() => Promise<void>> = [];

    beforeEach(async () => {
      app = undefined;
      closing = undefined;
      pool = new Pool({
        connectionString: databaseUrl,
        application_name: `acp-preparing-${randomUUID()}`,
        max: 4,
      });
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      app = await startBoundaryApplication(pool);
      app.model.complete.mockReset().mockResolvedValue(answer);
    });
    afterEach(async () => {
      await closeCase();
    });

    function application(): Application {
      if (app === undefined) throw new Error("ACP fixture did not start");
      return app;
    }

    function closeCase(): Promise<void> {
      closing ??= (async () => {
        const errors: unknown[] = [];
        for (const close of streams.splice(0)) {
          try {
            await close();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          if (app !== undefined) await app.close();
        } catch (error) {
          errors.push(error);
        } finally {
          if (app !== undefined) {
            // Join original reads even when closing a connection detached them.
            await Promise.allSettled(
              app.readOutput.mock.results.flatMap((result) =>
                result.type === "return" ? [result.value] : [],
              ),
            );
          }
          try {
            await pool.end();
            expect(pool.totalCount).toBe(0);
            expect(pool.waitingCount).toBe(0);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Preparing case cleanup failed", {
            cause: errors[0],
          });
      })();
      return closing;
    }

    async function state(alias = "owner") {
      const current = application();
      const response = await fetch(
        new URL("/rpc/agent-acp/get-agent-execution-state", current.httpUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...identityHeaders(current.identity(alias)),
          },
          body: "{}",
          signal: AbortSignal.timeout(5_000),
        },
      );
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      return body;
    }

    async function watch(alias = "owner") {
      const current = application();
      const controller = new AbortController();
      const frames: EventSourceMessage[] = [];
      const holder: { reader?: ReadableStreamDefaultReader<Uint8Array> } = {};
      let joined = Promise.resolve();
      let ended = false;
      let failure: unknown;
      streams.push(async () => {
        const errors: unknown[] = [];
        try {
          if (!ended && holder.reader !== undefined)
            await holder.reader.cancel();
        } catch (error) {
          errors.push(error);
        } finally {
          controller.abort();
          await joined;
        }
        if (failure !== undefined) errors.push(failure);
        if (errors.length > 0)
          throw new AggregateError(errors, "Preparing state stream failed");
      });
      const headersDeadline = setTimeout(() => controller.abort(), 5_000);
      let response: Response;
      try {
        response = await fetch(
          new URL(
            "/rpc/agent-acp/watch-agent-execution-state",
            current.httpUrl,
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...identityHeaders(current.identity(alias)),
            },
            body: "{}",
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(headersDeadline);
      }
      if (response.body === null) throw new Error("Missing state stream");
      holder.reader = response.body.getReader();
      const source = holder.reader;
      const parser = createParser({ onEvent: (event) => frames.push(event) });
      const decoder = new TextDecoder();
      const task = (async () => {
        try {
          for (;;) {
            const chunk = await source.read();
            if (chunk.done) {
              parser.feed(decoder.decode());
              return;
            }
            parser.feed(decoder.decode(chunk.value, { stream: true }));
          }
        } finally {
          ended = true;
          source.releaseLock();
        }
      })();
      joined = task.then(
        () => {},
        (error: unknown) => {
          failure = error;
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      await expect
        .poll(() => frames.length, { timeout: 5_000 })
        .toBeGreaterThan(0);
      return {
        frames,
        get ended() {
          return ended;
        },
        async join() {
          await joined;
          if (failure !== undefined)
            throw failure instanceof Error
              ? failure
              : new Error("Preparing state stream failed", { cause: failure });
        },
      };
    }

    function authorized(availability: "ready" | "offline") {
      return {
        agent_id: "agent-1",
        access_allowed: true,
        configuration_revision: expect.stringMatching(
          /^[a-f0-9]{64}$/u,
        ) as unknown,
        availability,
        active_session_id: null,
        unavailable_reason: availability === "ready" ? null : "agent_preparing",
      };
    }

    function denied(agentId = "agent-1") {
      return {
        agent_id: agentId,
        access_allowed: false,
        configuration_revision: null,
        availability: "offline",
        active_session_id: null,
        unavailable_reason: "access_denied",
      };
    }

    async function preparingSession(version: ProtocolVersion) {
      const current = application();
      const client = await current.connect(version);
      const created = await client.request("session/new", setup);
      expect(created.error).toBeUndefined();
      const sessionId = created.result?.sessionId;
      if (typeof sessionId !== "string") throw new Error("Missing Session ID");
      const executable = structuredClone(current.configuration.agents[0]!);
      const preparing = closedExecutionAgent(executable);
      preparing.unavailable_reason = "agent_preparing";
      current.configuration.agents[0] = preparing;
      // Apply a real Controller-shaped configuration through the production directory.
      await current.publishConfiguration();
      return { client, sessionId, executable };
    }

    it.each([1, 2] as const)(
      "v%i rejects a preparing Prompt before any durable intent, then executes the original request after publication",
      async (version) => {
        const current = application();
        const { client, sessionId, executable } =
          await preparingSession(version);
        const stream = await watch();
        expect(stream.frames[0]?.event).toBe("workspace_state");
        expect(JSON.parse(stream.frames[0]!.data)).toEqual(
          authorized("offline"),
        );
        expect(await state()).toEqual(authorized("offline"));
        const before = await boundaryState(pool);
        const append = await pool.query<{ append_version: string }>(
          "SELECT append_version FROM acp_sessions WHERE id = $1",
          [sessionId],
        );
        const intentId = `preparing-v${version}`;
        const prompt = {
          sessionId,
          prompt: [{ type: "text", text: "execute this original request" }],
          // Bridge intent metadata is currently a v1 extension; native v2
          // still exercises the same real createRunIntent persistence path.
          ...(version === 1
            ? {
                _meta: {
                  "antnest.dev/intent": {
                    intentId,
                    expectedAppendVersion: Number(
                      append.rows[0]!.append_version,
                    ),
                  },
                },
              }
            : {}),
        };
        const rejected = await client.request("session/prompt", prompt);
        expect(rejected.result).toBeUndefined();
        assertAdmissionError(rejected.error, "agent_preparing");
        expect(rejected.error.code).toBe(-32033);
        expect(rejected.error.data).toMatchObject({
          code: "agent_preparing",
          retryable: true,
          retry_after_ms: 1000,
        });
        expect(await boundaryState(pool)).toEqual(before);
        expect(current.createIntent).not.toHaveBeenCalled();
        expect(current.acceptRun).not.toHaveBeenCalled();
        expect(current.model.complete).not.toHaveBeenCalled();
        expect(current.tools.call).not.toHaveBeenCalled();
        expect(current.recoveryRequired).not.toHaveBeenCalled();

        current.configuration.agents[0] = executable;
        await current.publishConfiguration();
        expect(await state()).toEqual(authorized("ready"));
        await expect
          .poll(() => JSON.parse(stream.frames.at(-1)!.data) as unknown, {
            timeout: 5_000,
          })
          .toEqual(authorized("ready"));
        // This is an explicit second request; no automatic replay is introduced.
        const outputOffset = client.frames.length;
        const completed = await client.request("session/prompt", prompt);
        expect(completed.error).toBeUndefined();
        if (version === 1) {
          expect(completed.result).toEqual({ stopReason: "end_turn" });
        } else {
          expect(completed.result).toEqual({
            messageId: expect.stringMatching(/.+/u) as unknown,
          });
          await expect
            .poll(
              () =>
                client.frames
                  .slice(outputOffset)
                  .some(
                    (frame) =>
                      frame.method === "session/update" &&
                      frame.params?.sessionId === sessionId &&
                      frame.params.update?.state === "idle" &&
                      frame.params.update.stopReason === "end_turn",
                  ),
              { timeout: 5_000 },
            )
            .toBe(true);
        }
        await expect
          .poll(
            async () =>
              (
                await pool.query<Record<string, unknown>>(
                  `SELECT session_id, bridge_intent_id, state, stop_reason,
                    execution_snapshot->>'configurationRevision' AS revision
               FROM runs`,
                )
              ).rows,
            { timeout: 5_000 },
          )
          .toEqual([
            {
              session_id: sessionId,
              bridge_intent_id: version === 1 ? intentId : null,
              state: "completed",
              stop_reason: "end_turn",
              revision: String(current.configuration.revision),
            },
          ]);
        expect(current.createIntent).toHaveBeenCalledOnce();
        expect(current.acceptRun).toHaveBeenCalledOnce();
        expect(current.model.complete).toHaveBeenCalledOnce();
        expect(current.tools.call).not.toHaveBeenCalled();
      },
    );

    it.each([1, 2] as const)(
      "v%i keeps unauthorized and unlisted Agents denied while the listed Agent is preparing",
      async (version) => {
        const current = application();
        const { sessionId } = await preparingSession(version);
        current.identities.set("unauthorized", {
          ...current.identity(),
          principalId: "principal-denied",
        });
        current.identities.set("unlisted", {
          ...current.identity(),
          agentId: "agent-unlisted",
        });
        const before = await boundaryState(pool);
        for (const alias of ["unauthorized", "unlisted"]) {
          const expected = denied(current.identity(alias).agentId);
          expect(await state(alias)).toEqual(expected);
          const stream = await watch(alias);
          await expect.poll(() => stream.ended, { timeout: 5_000 }).toBe(true);
          await stream.join();
          expect(
            stream.frames.map((frame) => ({
              event: frame.event,
              data: JSON.parse(frame.data) as unknown,
            })),
          ).toEqual([{ event: "workspace_state", data: expected }]);
          const client = await current.connect(version, alias);
          const rejected = await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "must remain denied" }],
          });
          assertAdmissionError(rejected.error, "session_access_denied");
          expect(rejected.error.code).toBe(-32011);
          expect(rejected.result).toBeUndefined();
          const deniedCreation = await client.request("session/new", setup);
          assertAdmissionError(deniedCreation.error, "access_denied");
          expect(deniedCreation.result).toBeUndefined();
        }
        expect(await boundaryState(pool)).toEqual(before);
        expect(current.createIntent).not.toHaveBeenCalled();
        expect(current.acceptRun).not.toHaveBeenCalled();
        expect(current.model.complete).not.toHaveBeenCalled();
        expect(current.tools.call).not.toHaveBeenCalled();
      },
    );

    it.each([1, 2] as const)(
      "v%i revocation terminates the original preparing watch and cannot reopen it on regrant",
      async (version) => {
        const current = application();
        const { client, sessionId, executable } =
          await preparingSession(version);
        const stream = await watch();
        expect(JSON.parse(stream.frames[0]!.data)).toEqual(
          authorized("offline"),
        );
        const before = await boundaryState(pool);
        const preparing = current.configuration.agents[0]!;
        preparing.principal_ids = ["principal-2"];
        preparing.access_revision = "access-preparing-revoked";
        await current.publishConfiguration();
        // Natural EOF plus an actual joined reader proves server revocation,
        // independently from the afterEach client-side cancellation.
        await expect.poll(() => stream.ended, { timeout: 5_000 }).toBe(true);
        await stream.join();
        expect(
          stream.frames.map((frame) => ({
            event: frame.event,
            data: JSON.parse(frame.data) as unknown,
          })),
        ).toEqual([
          { event: "workspace_state", data: authorized("offline") },
          { event: "workspace_state", data: denied() },
        ]);
        expect(await state()).toEqual(denied());
        const rejected = await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "revoked preparing request" }],
        });
        assertAdmissionError(rejected.error, "access_denied");
        expect(await boundaryState(pool)).toEqual(before);

        current.configuration.agents[0] = {
          ...executable,
          access_revision: "access-preparing-regranted",
        };
        await current.publishConfiguration();
        expect(await state()).toEqual(authorized("ready"));
        expect(stream.ended).toBe(true);
        expect(stream.frames).toHaveLength(2);
        expect(current.createIntent).not.toHaveBeenCalled();
        expect(current.acceptRun).not.toHaveBeenCalled();
        expect(current.model.complete).not.toHaveBeenCalled();
        expect(current.tools.call).not.toHaveBeenCalled();
      },
    );
  },
);
