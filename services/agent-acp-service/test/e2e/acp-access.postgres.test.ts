import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/adapters/postgres/migrate.js";
import type { AcpWireClient, ProtocolVersion, WireFrame } from "../support/acp-wire-client.js";
import {
  boundaryState,
  startBoundaryApplication,
} from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const versions = [1, 2] as const;
type Application = Awaited<ReturnType<typeof startBoundaryApplication>>;

describe.skipIf(databaseUrl === undefined)("ACP wire and PostgreSQL access boundaries", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Application;
  let stopApplication = () => Promise.resolve();

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    stopApplication = app.close;
  });
  afterEach(async () => {
    await stopApplication();
  });
  afterAll(async () => {
    await pool.end();
  });

  describe.each(versions)("v%i", (version) => {
    it.each(["other-user", "other-agent"])(
      "isolates the owner's complete Session from %s",
      async (subject) => {
        const owner = await app.connect(version);
        const sessionId = await createSession(owner);
        await completePrompt(owner, sessionId, version);
        const foreign = await app.connect(version, subject);
        const foreignSessionId = await createSession(foreign);
        const setupUpdates = foreign.frames.filter((frame) => frame.method === "session/update");
        expect(setupUpdates).toHaveLength(2);
        expect(setupUpdates[0]?.params).toMatchObject({
          sessionId: foreignSessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: null,
            updatedAt: (await app.sessions.get(foreignSessionId))!.updatedAt.toISOString(),
          },
        });
        expect(setupUpdates[1]?.params).toMatchObject({
          sessionId: foreignSessionId,
          update: { sessionUpdate: "available_commands_update" },
        });
        const foreignOffset = foreign.frames.length;
        const listed = await foreign.request("session/list", {});
        expect(listed.result?.sessions).toEqual([
          expect.objectContaining({ sessionId: foreignSessionId }),
        ]);
        const before = await boundaryState(pool);
        const acceptedCount = app.acceptRun.mock.calls.length;
        const modelCount = app.model.complete.mock.calls.length;
        const toolCount = app.tools.call.mock.calls.length;

        for (const [method, params] of sessionCommands(version, sessionId)) {
          expectDenied(await foreign.request(method, params), "session_access_denied", -32020);
        }
        await rejectedCancellation(app, foreign, sessionId, "session_access_denied");

        expect(await boundaryState(pool)).toEqual(before);
        expect(app.acceptRun).toHaveBeenCalledTimes(acceptedCount);
        expect(app.model.complete).toHaveBeenCalledTimes(modelCount);
        expect(app.tools.call).toHaveBeenCalledTimes(toolCount);
        expect(app.recoveryRequired).not.toHaveBeenCalled();
        expect(
          foreign.frames.slice(foreignOffset).filter((frame) => frame.method === "session/update"),
        ).toEqual([]);
        expect(JSON.stringify(foreign.frames)).not.toMatch(/owner-only|private\.txt/u);

        await assertReplay(owner, sessionId, version);
        expect(app.model.complete).toHaveBeenCalledTimes(modelCount);
        expect(app.tools.call).toHaveBeenCalledTimes(toolCount);
        expect(app.acceptRun).toHaveBeenCalledTimes(acceptedCount);
      },
    );

    it("applies revocation to existing connections before recording any new intent", async () => {
      const owner = await app.connect(version);
      const sessionId = await createSession(owner);
      await completePrompt(owner, sessionId, version);
      app.configuration.agents[0]!.principal_ids = ["principal-2"];
      app.configuration.agents[0]!.access_revision = "access-2";
      await app.publishConfiguration();
      const before = await boundaryState(pool);
      const offset = owner.frames.length;
      const modelCount = app.model.complete.mock.calls.length;
      const toolCount = app.tools.call.mock.calls.length;
      for (const [method, params] of [
        ["session/new", { cwd: "/workspace", mcpServers: [] }],
        ["session/list", {}],
        ...sessionCommands(version, sessionId),
      ] as Array<[string, Record<string, unknown>]>) {
        expectDenied(await owner.request(method, params), "access_denied", -32020);
      }
      await rejectedCancellation(app, owner, sessionId, "access_denied");
      expect(await boundaryState(pool)).toEqual(before);
      expect(app.createIntent).toHaveBeenCalledOnce();
      expect(app.acceptRun).toHaveBeenCalledOnce();
      expect(app.model.complete).toHaveBeenCalledTimes(modelCount);
      expect(app.tools.call).toHaveBeenCalledTimes(toolCount);
      expect(app.finish).toHaveBeenCalledOnce();
      expect(app.recoveryRequired).not.toHaveBeenCalled();
      expect(
        owner.frames.slice(offset).filter((frame) => frame.method === "session/update"),
      ).toEqual([]);

      app.configuration.agents[0]!.principal_ids = ["principal-1", "principal-2"];
      app.configuration.agents[0]!.access_revision = "access-3";
      await app.publishConfiguration();
      await assertReplay(owner, sessionId, version);
      await completePrompt(owner, sessionId, version);
      expect(app.acceptRun.mock.lastCall?.[0].snapshot.accessRevision).toBe("access-3");
      expect(app.model.complete).toHaveBeenCalledTimes(modelCount + 1);
    });

    it("uses a new access revision without replacing an authorized connection", async () => {
      const owner = await app.connect(version);
      const sessionId = await createSession(owner);
      await completePrompt(owner, sessionId, version);
      app.configuration.agents[0]!.access_revision = "access-2";
      await app.publishConfiguration();
      await assertReplay(owner, sessionId, version);
      await completePrompt(owner, sessionId, version);
      expect(app.acceptRun.mock.lastCall?.[0].snapshot.accessRevision).toBe("access-2");
      expect(app.recoveryRequired).not.toHaveBeenCalled();
    });

    it.each(["other-user", "other-agent"])(
      "protects an active Run from %s without cancelling the owner",
      async (alias) => {
        const owner = await app.connect(version);
        const sessionId = await createSession(owner);
        const foreign = await app.connect(version, alias);
        const running = await startControlledRun(app, owner, sessionId);
        try {
          expectDenied(
            await foreign.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "foreign prompt while owner runs" }],
            }),
            "session_access_denied",
            -32020,
          );
          const before = await boundaryState(pool);
          await rejectedCancellation(app, foreign, sessionId, "session_access_denied");
          expect(running.signal.aborted).toBe(false);
          expect(await boundaryState(pool)).toEqual(before);
          expect(app.model.complete).toHaveBeenCalledOnce();
          expect(app.acceptRun).toHaveBeenCalledOnce();
          expect((await pool.query("SELECT state,cancel_requested_at FROM runs")).rows).toEqual([
            { state: "running", cancel_requested_at: null },
          ]);
        } finally {
          running.release();
          await running.prompt;
        }
        await expect
          .poll(async () => (await pool.query<{ state: string }>("SELECT state FROM runs")).rows)
          .toEqual([{ state: "completed" }]);
        expect(app.finish).toHaveBeenCalledWith(
          expect.objectContaining({ terminalClass: "completed" }),
        );
      },
    );

    it("lets a still-authorized connection cancel after the access revision changes", async () => {
      const owner = await app.connect(version);
      const sessionId = await createSession(owner);
      const running = await startControlledRun(app, owner, sessionId);
      try {
        app.configuration.agents[0]!.access_revision = "access-2";
        await app.publishConfiguration();
        expect(running.signal.aborted).toBe(false);
        owner.notify("session/cancel", { sessionId });
        await expect.poll(() => running.signal.aborted).toBe(true);
        await expect
          .poll(async () => (await pool.query<{ state: string }>("SELECT state FROM runs")).rows)
          .toEqual([{ state: "cancelled" }]);
        expect(app.acceptRun).toHaveBeenCalledOnce();
      } finally {
        running.release();
        await running.prompt;
      }
    });

    it("revokes an in-flight Run and prevents its buffered output from leaking", async () => {
      const owner = await app.connect(version);
      const sessionId = await createSession(owner);
      const running = await startControlledRun(app, owner, sessionId);
      try {
        app.configuration.agents[0]!.principal_ids = ["principal-2"];
        app.configuration.agents[0]!.access_revision = "access-2";
        await app.publishConfiguration();
        expect(running.signal.aborted).toBe(true);
        await expect
          .poll(async () => (await pool.query<{ state: string }>("SELECT state FROM runs")).rows)
          .toEqual([{ state: "cancelled" }]);
        expect(JSON.stringify(owner.frames)).not.toContain("completed by owner");
        expect(app.tools.call).not.toHaveBeenCalled();
        expect(app.acceptRun).toHaveBeenCalledOnce();
        expect(app.recoveryRequired).not.toHaveBeenCalled();
      } finally {
        running.release();
        await running.prompt;
      }
    });
  });
});

async function startControlledRun(app: Application, owner: AcpWireClient, sessionId: string) {
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  app.model.complete.mockReset().mockImplementation(async ({ signal }) => {
    started.resolve(signal);
    const abort = () => release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await release.promise;
    } finally {
      signal.removeEventListener("abort", abort);
    }
    return {
      kind: "message",
      content: [{ type: "text", text: "completed by owner" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const prompt = owner
    .request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Wait for the controlled fixture" }],
    })
    .then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
  const signal = await started.promise;
  return { signal, prompt, release: () => release.resolve() };
}

async function createSession(client: AcpWireClient): Promise<string> {
  const response = await client.request("session/new", { cwd: "/workspace", mcpServers: [] });
  expect(response.error).toBeUndefined();
  const id = response.result?.sessionId;
  if (typeof id !== "string") throw new Error("Missing Session ID");
  return id;
}

async function completePrompt(client: AcpWireClient, sessionId: string, version: ProtocolVersion) {
  const offset = client.frames.length;
  const response = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "owner-only-prompt" }],
  });
  expect(response.error).toBeUndefined();
  if (version === 1) expect(response.result).toEqual({ stopReason: "end_turn" });
  else
    await expect
      .poll(() =>
        client.frames
          .slice(offset)
          .some(
            (frame) =>
              frame.params?.update?.state === "idle" &&
              frame.params.update.stopReason === "end_turn",
          ),
      )
      .toBe(true);
}

async function assertReplay(client: AcpWireClient, sessionId: string, version: ProtocolVersion) {
  const offset = client.frames.length;
  const replay = await client.request(replayMethod(version), sessionParams(sessionId, version));
  expect(replay.error).toBeUndefined();
  const frames = client.frames.slice(offset).filter((frame) => frame.method === "session/update");
  expect(frames.every((frame) => frame.params?.sessionId === sessionId)).toBe(true);
  const text = JSON.stringify(frames);
  expect(text).toContain("owner-only-prompt");
  expect(text).toContain("owner-only-tool-output");
  expect(text).toContain("owner-only-response");
  expect(text.indexOf("owner-only-prompt")).toBeLessThan(text.indexOf("owner-only-tool-output"));
  expect(text.indexOf("owner-only-tool-output")).toBeLessThan(text.indexOf("owner-only-response"));
}

function replayMethod(version: ProtocolVersion) {
  return version === 1 ? "session/load" : "session/resume";
}

function sessionParams(sessionId: string, version: ProtocolVersion) {
  return {
    sessionId,
    cwd: "/workspace",
    mcpServers: [],
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  };
}

function sessionCommands(
  version: ProtocolVersion,
  sessionId: string,
): Array<[string, Record<string, unknown>]> {
  const setup = sessionParams(sessionId, version);
  return [
    [replayMethod(version), setup],
    ...(version === 1 ? [["session/resume", setup] as [string, Record<string, unknown>]] : []),
    ["session/fork", setup],
    ["session/close", { sessionId }],
    ["session/delete", { sessionId }],
    ["session/prompt", { sessionId, prompt: [{ type: "text", text: "unauthorized" }] }],
  ];
}

function expectDenied(frame: WireFrame, code: string, wireCode: number) {
  expect(frame.result).toBeUndefined();
  expect(frame.error).toMatchObject({ code: wireCode, data: { code, retryable: false } });
}

async function rejectedCancellation(
  app: Application,
  client: AcpWireClient,
  sessionId: string,
  code: string,
) {
  const offset = client.frames.length;
  const index = app.cancel.mock.calls.length;
  client.notify("session/cancel", { sessionId });
  await expect.poll(() => app.cancel.mock.settledResults[index]?.type).toBe("rejected");
  expect(app.cancel.mock.settledResults[index]?.value).toMatchObject({ code });
  const probe = await client.request("session/list", {});
  if (code === "session_access_denied") expect(probe.error).toBeUndefined();
  else expect(probe.error?.data?.code).toBe(code);
  expect(
    client.frames
      .slice(offset)
      .filter(
        (frame) =>
          frame.id !== undefined || frame.result !== undefined || frame.error !== undefined,
      ),
  ).toEqual([probe]);
}
