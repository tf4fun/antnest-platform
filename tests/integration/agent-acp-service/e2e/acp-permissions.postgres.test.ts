import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import type { AcpWireClient } from "../support/acp-wire-client.js";
import { identityHeaders } from "../../../../services/agent-acp-service/test/support/fixtures.js";
import type { SessionConfiguration } from "../../../../services/agent-acp-service/src/domain/session-configuration.js";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const permissionMethod = "session/request_permission";

async function pending(client: AcpWireClient, index = 0) {
  await expect
    .poll(
      () =>
        client.frames.filter((frame) => frame.method === permissionMethod)
          .length,
    )
    .toBeGreaterThan(index);
  const frame = client.frames.filter(
    (frame) => frame.method === permissionMethod,
  )[index]!;
  expect(frame.id).toBeDefined();
  return frame;
}
function respond(client: AcpWireClient, id: number, optionId: string) {
  client.respond(id, { outcome: { outcome: "selected", optionId } });
}

function requestMeta(frame: { params?: unknown }) {
  return (
    (frame.params as Record<string, unknown> | undefined)?._meta as
      Record<string, Record<string, unknown>> | undefined
  )?.["antnest.dev/permission-request"];
}

function resolutionMeta(frame: { params?: unknown }) {
  const update = (frame.params as Record<string, unknown> | undefined)
    ?.update as Record<string, unknown> | undefined;
  return (
    update?._meta as Record<string, Record<string, unknown>> | undefined
  )?.["antnest.dev/permission-resolution"];
}

async function waitNotice(client: AcpWireClient, reason: string) {
  const found = () =>
    client.frames.find((frame) => {
      const update = (frame.params as Record<string, unknown> | undefined)
        ?.update as Record<string, unknown> | undefined;
      const meta = resolutionMeta(frame);
      return (
        frame.method === "session/update" &&
        update?.sessionUpdate === "notice" &&
        meta?.reason === reason
      );
    });
  await expect.poll(found).not.toBeUndefined();
  return found()!;
}

describe.skipIf(databaseUrl === undefined)(
  "ACP permission protocol with durable Runs",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
    const httpConnections: acp.ClientConnection[] = [];
    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      app = await startBoundaryApplication(pool);
      app.configuration.agents[0]!.default_authorization.mode = "approve";
      await app.publishConfiguration();
    });
    afterEach(async () => {
      for (const connection of httpConnections.splice(0)) connection.close();
      await app.close();
    });
    afterAll(async () => {
      await pool.end();
    });

    async function waitDone(timeout?: number) {
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM runs WHERE state = 'running'",
              )
            ).rows[0]?.n,
          timeout === undefined ? undefined : { timeout },
        )
        .toBe(0);
    }

    for (const version of [1, 2] as const) {
      for (const decision of [
        "allow_once",
        "allow_always",
        "reject_once",
        "reject_always",
      ] as const) {
        it(`v${version}: ${decision} validates the wire schema and controls actual Tool dispatch`, async () => {
          const client = await app.connect(version);
          const created = await client.request("session/new", setup);
          const sessionId = String(created.result?.sessionId);
          const prompt = client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "read" }],
          });
          const frame = await pending(client);
          const schema = version === 1 ? v1Schema : v2Schema;
          const validate = new Ajv2020({
            strict: false,
            validateFormats: false,
          }).compile({
            $ref: "#/$defs/RequestPermissionRequest",
            $defs: schema.$defs,
          });
          expect(validate(frame.params), JSON.stringify(validate.errors)).toBe(
            true,
          );
          expect(app.tools.call).not.toHaveBeenCalled();
          expect(
            (
              await pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM tool_attempts",
              )
            ).rows[0]?.n,
          ).toBe(0);
          expect(
            (await pool.query("SELECT decision FROM tool_permissions")).rows,
          ).toEqual([{ decision: null }]);
          respond(client, frame.id!, decision);
          expect((await prompt).error).toBeUndefined();
          await waitDone();
          expect(app.tools.call).toHaveBeenCalledTimes(
            decision.startsWith("allow") ? 1 : 0,
          );
          expect(
            (await pool.query("SELECT decision FROM tool_permissions")).rows,
          ).toEqual([{ decision }]);
          const configuration = (
            await pool.query<{ configuration: SessionConfiguration }>(
              "SELECT configuration FROM acp_sessions WHERE id = $1",
              [sessionId],
            )
          ).rows[0]?.configuration;
          expect(configuration?.toolRules?.length ?? 0).toBe(
            decision.endsWith("always") ? 1 : 0,
          );
        });
      }

      it(`v${version}: always rules apply within this Run and survive load into the next Run`, async () => {
        const client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        const toolResponse = {
          kind: "tool_calls" as const,
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: [{ id: "read", name: "read", arguments: { path: "x" } }],
        };
        app.model.complete
          .mockReset()
          .mockResolvedValueOnce(toolResponse)
          .mockResolvedValueOnce(toolResponse)
          .mockResolvedValue({
            kind: "message",
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        const prompt = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "read twice" }],
        });
        const frame = await pending(client);
        respond(client, frame.id!, "allow_always");
        await prompt;
        await waitDone();
        expect(app.tools.call).toHaveBeenCalledTimes(2);
        expect(
          client.frames.filter((item) => item.method === permissionMethod),
        ).toHaveLength(1);
        const other = await app.connect(version);
        await other.request(version === 1 ? "session/load" : "session/resume", {
          ...setup,
          sessionId,
        });
        app.model.complete.mockResolvedValueOnce(toolResponse);
        await other.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "again" }],
        });
        await waitDone();
        expect(app.tools.call).toHaveBeenCalledTimes(3);
        expect(
          other.frames.filter((item) => item.method === permissionMethod),
        ).toHaveLength(0);
      });

      it(`v${version}: cancellation closes the current and remaining undispatched Tool results`, async () => {
        const client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        app.model.complete.mockReset().mockResolvedValue({
          kind: "tool_calls",
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: ["first", "second"].map((id) => ({
            id,
            name: "read",
            arguments: { path: "x" },
          })),
        });
        const prompt = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "read" }],
        });
        const frame = await pending(client);
        client.notify("session/cancel", { sessionId });
        await expect.poll(() => app.cancel.mock.calls.length).toBe(1);
        client.respond(frame.id!, { outcome: { outcome: "cancelled" } });
        await prompt;
        await waitDone();
        expect(
          (await pool.query("SELECT state, tool_effect_state FROM runs")).rows,
        ).toEqual([{ state: "cancelled", tool_effect_state: "none" }]);
        expect(app.tools.call).not.toHaveBeenCalled();
        expect(
          (await pool.query("SELECT decision FROM tool_permissions")).rows,
        ).toEqual([{ decision: "cancelled" }]);
        const messages = (
          await pool.query(
            "SELECT payload FROM session_messages WHERE kind = 'tool_call' ",
          )
        ).rows;
        expect(messages).toHaveLength(2);
      });
    }

    for (const version of [1, 2] as const) {
      it(`v${version}: fans one pending approval to every same-owner attachment and commits once`, async () => {
        const first = await app.connect(version, "owner", { notices: true });
        const created = await first.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        const second = await app.connect(version, "owner", { notices: true });
        await second.request(
          version === 1 ? "session/load" : "session/resume",
          { ...setup, sessionId },
        );
        const foreign = await app.connect(version, "other-user");
        expect(
          (
            await foreign.request(
              version === 1 ? "session/load" : "session/resume",
              { ...setup, sessionId },
            )
          ).error,
        ).toBeDefined();
        const prompt = first.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "read" }],
        });
        const firstFrame = await pending(first);
        const secondFrame = await pending(second);
        expect(
          foreign.frames.filter((frame) => frame.method === permissionMethod),
        ).toHaveLength(0);
        const correlation = requestMeta(firstFrame);
        expect(correlation).toMatchObject({ version: 1 });
        expect(typeof correlation?.runId).toBe("string");
        expect(correlation?.runId).not.toBe("");
        expect(typeof correlation?.toolCallId).toBe("string");
        expect(correlation?.toolCallId).not.toBe("");
        expect(requestMeta(secondFrame)).toEqual(correlation);
        respond(first, firstFrame.id!, "allow_once");
        expect((await prompt).error).toBeUndefined();
        const envelopeDef =
          version === 1 ? "SessionNotification" : "UpdateSessionNotification";
        const schema = version === 1 ? v1Schema : v2Schema;
        const envelope = new Ajv2020({
          strict: false,
          validateFormats: false,
        }).compile({ $ref: `#/$defs/${envelopeDef}`, $defs: schema.$defs });
        const resolution = new Ajv2020({ strict: false }).compile(
          JSON.parse(
            readFileSync(
              new URL(
                "../../../../contracts/agent-acp/permission-resolution.schema.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ) as Record<string, unknown>,
        );
        for (const client of [first, second]) {
          const notice = await waitNotice(client, "permission_resolved");
          expect(envelope(notice.params), JSON.stringify(envelope.errors)).toBe(
            true,
          );
          const meta = resolutionMeta(notice);
          expect(resolution(meta), JSON.stringify(resolution.errors)).toBe(
            true,
          );
          expect(meta).toMatchObject({
            runId: correlation!.runId,
            toolCallId: correlation!.toolCallId,
          });
        }
        respond(second, secondFrame.id!, "reject_always");
        const ordered = await second.request("session/list", {});
        expect(ordered.error).toBeUndefined();
        await waitDone();
        expect(app.tools.call).toHaveBeenCalledTimes(1);
        expect(
          (await pool.query("SELECT decision,reason FROM tool_permissions"))
            .rows,
        ).toEqual([{ decision: "allow_once", reason: "client_response" }]);
        const configuration = (
          await pool.query<{ configuration: SessionConfiguration }>(
            "SELECT configuration FROM acp_sessions WHERE id = $1",
            [sessionId],
          )
        ).rows[0]?.configuration;
        expect(configuration?.toolRules?.length ?? 0).toBe(0);
      });

      it(`v${version}: the approval deadline ends an unanswered wait as permission_timeout`, async () => {
        await app.close();
        app = await startBoundaryApplication(pool, undefined, {
          permissionTimeoutMs: 200,
          runTimeoutMs: 5000,
        });
        const client = await app.connect(version, "owner", { notices: true });
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        const prompt = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "read" }],
        });
        const frame = await pending(client);
        const correlation = requestMeta(frame);
        const resolution = new Ajv2020({ strict: false }).compile(
          JSON.parse(
            readFileSync(
              new URL(
                "../../../../contracts/agent-acp/permission-resolution.schema.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ) as Record<string, unknown>,
        );
        const notice = await waitNotice(client, "permission_timeout");
        const meta = resolutionMeta(notice);
        expect(resolution(meta), JSON.stringify(resolution.errors)).toBe(true);
        expect(meta).toMatchObject({
          runId: correlation!.runId,
          toolCallId: correlation!.toolCallId,
        });
        respond(client, frame.id!, "allow_always");
        const ordered = await client.request("session/list", {});
        expect(ordered.error).toBeUndefined();
        await waitDone(3000);
        expect((await prompt).error).toBeUndefined();
        expect(app.tools.call).not.toHaveBeenCalled();
        expect(
          (await pool.query("SELECT decision,reason FROM tool_permissions"))
            .rows,
        ).toEqual([{ decision: "cancelled", reason: "permission_timeout" }]);
        expect(
          (
            await pool.query<{ state: string; error_class: string | null }>(
              "SELECT state,error_class FROM runs",
            )
          ).rows,
        ).toEqual([{ state: "completed", error_class: null }]);
        const configuration = (
          await pool.query<{ configuration: SessionConfiguration }>(
            "SELECT configuration FROM acp_sessions WHERE id = $1",
            [sessionId],
          )
        ).rows[0]?.configuration;
        expect(configuration?.toolRules?.length ?? 0).toBe(0);
      });
    }

    it("reconnects a pending v2 Run without letting another identity answer", async () => {
      const client = await app.connect(2);
      const sessionId = String(
        (await client.request("session/new", setup)).result?.sessionId,
      );
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "read" }],
      });
      await pending(client);
      const foreign = await app.connect(2, "other-user");
      expect(
        (await foreign.request("session/resume", { ...setup, sessionId }))
          .error,
      ).toBeDefined();
      expect(
        foreign.frames.filter((item) => item.method === permissionMethod),
      ).toHaveLength(0);
      await client.close();
      const restored = await app.connect(1);
      await restored.request("session/load", { ...setup, sessionId });
      const frame = await pending(restored);
      respond(restored, frame.id!, "allow_once");
      await waitDone();
      expect(app.tools.call).toHaveBeenCalledOnce();
      expect(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM tool_permissions",
          )
        ).rows[0]?.n,
      ).toBe(1);
    });

    for (const decision of ["allow_always", "reject_always"] as const) {
      it(`fork never inherits the parent Session's ${decision} rules`, async () => {
        const client = await app.connect(2);
        const sessionId = String(
          (await client.request("session/new", setup)).result?.sessionId,
        );
        await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "read" }],
        });
        respond(client, (await pending(client)).id!, decision);
        await waitDone();
        const forked = await client.request("session/fork", {
          ...setup,
          sessionId,
        });
        expect(forked.error).toBeUndefined();
        const childId = String(forked.result?.sessionId);
        expect(
          (
            await pool.query<{ configuration: SessionConfiguration }>(
              "SELECT configuration FROM acp_sessions WHERE id=$1",
              [childId],
            )
          ).rows[0]?.configuration.toolRules,
        ).toBeUndefined();
        app.model.complete.mockResolvedValueOnce({
          kind: "tool_calls",
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: [{ id: "child-read", name: "read", arguments: { path: "x" } }],
        });
        await client.request("session/prompt", {
          sessionId: childId,
          prompt: [{ type: "text", text: "read" }],
        });
        const frame = await pending(client, 1);
        expect(frame.params?.sessionId).toBe(childId);
        respond(client, frame.id!, "reject_once");
        await waitDone();
      });
    }

    it("HTTP uses the official client's reverse request channel, not a private approval API", async () => {
      const requested = Promise.withResolvers<acp.RequestPermissionRequest>();
      const answer = Promise.withResolvers<acp.RequestPermissionResponse>();
      const connection = acp
        .client()
        .onRequest(
          acp.methods.client.session.requestPermission,
          ({ params }) => {
            requested.resolve(params);
            return answer.promise;
          },
        )
        .connect(createHttpStream(app.httpUrl, { headers: identityHeaders() }));
      httpConnections.push(connection);
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const { sessionId } =
        await connection.agent.request<acp.NewSessionResponse>(
          acp.methods.agent.session.new,
          setup,
        );
      const prompt = connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId,
          prompt: [{ type: "text", text: "read" }],
        },
      );
      const request = await requested.promise;
      expect(request.toolCall.rawInput).toEqual({ path: "private.txt" });
      expect(app.tools.call).not.toHaveBeenCalled();
      answer.resolve({
        outcome: { outcome: "selected", optionId: "allow_once" },
      });
      expect(await prompt).toEqual({ stopReason: "end_turn" });
      expect(app.tools.call).toHaveBeenCalledOnce();
    });

    it("HTTP clients without an approval handler fail closed without hanging the Run", async () => {
      const connection = acp.client().connect(
        createHttpStream(app.httpUrl, {
          headers: identityHeaders(),
        }),
      );
      httpConnections.push(connection);
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const { sessionId } =
        await connection.agent.request<acp.NewSessionResponse>(
          acp.methods.agent.session.new,
          setup,
        );
      await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "read" }],
      });
      expect(app.tools.call).not.toHaveBeenCalled();
      expect(
        (await pool.query("SELECT decision,reason FROM tool_permissions")).rows,
      ).toEqual([{ decision: "cancelled", reason: "permission_unavailable" }]);
    });

    it("expires a waiting approval at the local Run deadline, with no Tool side effect", async () => {
      await app.close();
      app = await startBoundaryApplication(pool, undefined, {
        runTimeoutMs: 1000,
      });
      const client = await app.connect(2);
      const sessionId = String(
        (await client.request("session/new", setup)).result?.sessionId,
      );
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "read" }],
      });
      const frame = await pending(client);
      // The 1 s Run deadline must elapse before cancellation and durable
      // settlement can finish; Vitest's 1 s default poll budget races that work.
      await waitDone(5000);
      client.respond(frame.id!, { outcome: { outcome: "cancelled" } });
      expect(app.tools.call).not.toHaveBeenCalled();
      expect(
        (
          await pool.query(
            "SELECT state,error_class,tool_effect_state FROM runs",
          )
        ).rows,
      ).toEqual([
        {
          state: "failed",
          error_class: "run_deadline_exceeded",
          tool_effect_state: "none",
        },
      ]);
      expect(
        (await pool.query("SELECT decision FROM tool_permissions")).rows,
      ).toEqual([{ decision: "cancelled" }]);
    });

    it("does not execute or save an always rule after access revocation", async () => {
      const client = await app.connect(2);
      const sessionId = String(
        (await client.request("session/new", setup)).result?.sessionId,
      );
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "read" }],
      });
      const frame = await pending(client);
      app.configuration.agents[0]!.principal_ids = ["principal-2"];
      app.configuration.agents[0]!.access_revision = "access-2";
      await app.publishConfiguration();
      respond(client, frame.id!, "allow_always");
      await waitDone();
      expect(app.tools.call).not.toHaveBeenCalled();
      expect(
        (await pool.query("SELECT decision FROM tool_permissions")).rows,
      ).toEqual([{ decision: "cancelled" }]);
      expect(
        (
          await pool.query<{ configuration: SessionConfiguration }>(
            "SELECT configuration FROM acp_sessions",
          )
        ).rows[0]?.configuration,
      ).toEqual({});
    });
  },
);
