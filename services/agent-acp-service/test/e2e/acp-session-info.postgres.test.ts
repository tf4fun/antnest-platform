import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import type { ModelResult } from "../../src/ports/model.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import type { AcpWireClient, ProtocolVersion } from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const answer: ModelResult = {
  kind: "message",
  content: [{ type: "text", text: "answer" }],
  stopReason: "end_turn",
  usage: { inputTokens: 2, outputTokens: 1 },
};
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionInfoUpdate",
    $defs: schema.$defs,
  }),
);
function updates(client: AcpWireClient, sessionId: string) {
  return client.frames.filter(
    (frame) =>
      frame.method === "session/update" &&
      frame.params?.sessionId === sessionId &&
      frame.params.update?.sessionUpdate === "session_info_update",
  );
}
function prompt(client: AcpWireClient, sessionId: string, text: string) {
  return client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}
function reopen(client: AcpWireClient, version: ProtocolVersion, sessionId: string) {
  return client.request(version === 1 ? "session/load" : "session/resume", { ...setup, sessionId });
}

describe.skipIf(databaseUrl === undefined)("Session metadata across observers and recovery", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  let release = () => {};
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    app.model.complete.mockReset().mockResolvedValue(answer);
  });
  afterEach(async () => {
    release();
    await app.close();
  });
  afterAll(async () => {
    await pool.end();
  });
  async function info(sessionId: string) {
    const stored = (await app.sessions.get(sessionId))!;
    return {
      sessionUpdate: "session_info_update",
      title: stored.title,
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
  async function expectInfo(client: AcpWireClient, sessionId: string, version: ProtocolVersion) {
    const expected = await info(sessionId);
    await expect.poll(() => updates(client, sessionId).at(-1)?.params?.update).toEqual(expected);
    const validator = validators[version - 1]!;
    for (const frame of updates(client, sessionId)) {
      expect(validator(frame.params?.update), JSON.stringify(validator.errors)).toBe(true);
      expect(Number.isFinite(Date.parse(String(frame.params?.update?.updatedAt)))).toBe(true);
    }
    return expected;
  }
  async function settle() {
    await expect
      .poll(
        async () =>
          (
            await pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM runs WHERE state IN ('admitting','running')",
            )
          ).rows[0]?.n,
      )
      .toBe(0);
  }

  it.each([1, 2] as const)(
    "v%i updates all authorized observers during and after a Run, configuration and close",
    async (version) => {
      const owner = await app.connect(version);
      const sessionId = String((await owner.request("session/new", setup)).result?.sessionId);
      const observers = await Promise.all([app.connect(1), app.connect(2)]);
      for (const [index, observer] of observers.entries())
        expect(
          (await reopen(observer, (index + 1) as ProtocolVersion, sessionId)).error,
        ).toBeUndefined();
      const strangers = await Promise.all([
        app.connect(1, "other-user"),
        app.connect(2, "other-agent"),
      ]);
      for (const [index, stranger] of strangers.entries())
        expect(
          (await reopen(stranger, (index + 1) as ProtocolVersion, sessionId)).error,
        ).toBeDefined();
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<ModelResult>();
      release = () => gate.resolve(answer);
      app.model.complete.mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      const active = prompt(owner, sessionId, "shared session title");
      await started.promise;
      try {
        for (const [index, observer] of observers.entries())
          await expectInfo(observer, sessionId, (index + 1) as ProtocolVersion);
        await expectInfo(owner, sessionId, version);
      } finally {
        release();
        expect((await active).error).toBeUndefined();
      }
      await settle();
      for (const [index, observer] of observers.entries())
        await expectInfo(observer, sessionId, (index + 1) as ProtocolVersion);
      const final = await expectInfo(owner, sessionId, version);
      expect(final.title).toBe("shared session title");
      expect((await owner.request("session/list", {})).result?.sessions).toContainEqual({
        sessionId,
        cwd: "/workspace",
        title: final.title,
        updatedAt: final.updatedAt,
      });
      expect(
        (
          await owner.request("session/set_config_option", {
            sessionId,
            configId: "mode",
            value: "chat",
            ...(version === 2 ? { type: "id" } : {}),
          })
        ).error,
      ).toBeUndefined();
      for (const [index, observer] of observers.entries())
        await expectInfo(observer, sessionId, (index + 1) as ProtocolVersion);
      expect((await owner.request("session/close", { sessionId })).error).toBeUndefined();
      for (const [index, observer] of observers.entries())
        await expectInfo(observer, sessionId, (index + 1) as ProtocolVersion);
      for (const stranger of strangers) expect(updates(stranger, sessionId)).toEqual([]);
    },
  );

  it.each([
    [1, "session/load", true],
    [1, "session/resume", false],
    [2, "session/resume", false],
    [2, "session/resume", true],
  ] as const)(
    "v%i %s replay=%s restores current metadata after restart without changing time or replaying execution",
    async (version, method, replay) => {
      const owner = await app.connect(1);
      const sessionId = String((await owner.request("session/new", setup)).result?.sessionId);
      expect((await prompt(owner, sessionId, "retained title")).error).toBeUndefined();
      const expected = await info(sessionId);
      await app.close();
      app = await startBoundaryApplication(pool);
      app.model.complete.mockReset().mockResolvedValue(answer);
      const client = await app.connect(version);
      const result = await client.request(method, {
        ...setup,
        sessionId,
        ...(version === 2 && replay ? { replayFrom: { type: "start" } } : {}),
      });
      expect(result.error).toBeUndefined();
      expect(await expectInfo(client, sessionId, version)).toEqual(expected);
      expect(updates(client, sessionId)).toHaveLength(1);
      const messages = client.frames.filter(
        (frame) =>
          frame.params?.update?.sessionUpdate ===
          (version === 1 ? "agent_message_chunk" : "agent_message"),
      );
      expect(messages.length > 0).toBe(replay);
      expect(app.model.complete).not.toHaveBeenCalled();
      expect(app.tools.call).not.toHaveBeenCalled();
      expect(
        (await prompt(client, sessionId, "next turn keeps first title")).error,
      ).toBeUndefined();
      await settle();
      expect((await expectInfo(client, sessionId, version)).title).toBe(expected.title);
    },
  );

  it.each([1, 2] as const)(
    "v%i new and fork publish their own persisted metadata without borrowing the parent's time",
    async (version) => {
      const client = await app.connect(version);
      const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
      expect((await expectInfo(client, sessionId, version)).title).toBeNull();
      expect((await prompt(client, sessionId, "parent title")).error).toBeUndefined();
      await settle();
      await pool.query(
        "UPDATE acp_sessions SET updated_at = '2026-09-01T00:00:00Z' WHERE id = $1",
        [sessionId],
      );
      const parent = await info(sessionId);
      const forked = await client.request("session/fork", { ...setup, sessionId });
      expect(forked.error).toBeUndefined();
      const forkId = String(forked.result?.sessionId);
      const fork = await expectInfo(client, forkId, version);
      expect(fork.title).toBe(parent.title);
      expect(fork.updatedAt).not.toBe(parent.updatedAt);
      expect(await info(sessionId)).toEqual(parent);
      expect(app.model.complete).toHaveBeenCalledOnce();
    },
  );
});
