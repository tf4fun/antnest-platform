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
        const listed = await foreign.request("session/list", {});
        expect(listed.result?.sessions).toEqual([
          expect.objectContaining({ sessionId: foreignSessionId }),
        ]);
        const before = await boundaryState(pool);
        const acquireCount = app.controller.acquireRun.mock.calls.length;
        const modelCount = app.model.complete.mock.calls.length;
        const toolCount = app.tools.call.mock.calls.length;

        for (const [method, params] of sessionCommands(version, sessionId)) {
          expectDenied(await foreign.request(method, params), "session_access_denied", -32020);
        }
        await rejectedCancellation(app, foreign, sessionId, "session_access_denied");

        expect(await boundaryState(pool)).toEqual(before);
        expect(app.controller.acquireRun).toHaveBeenCalledTimes(acquireCount);
        expect(app.model.complete).toHaveBeenCalledTimes(modelCount);
        expect(app.tools.call).toHaveBeenCalledTimes(toolCount);
        expect(app.recoveryRequired).not.toHaveBeenCalled();
        expect(foreign.frames.filter((frame) => frame.method === "session/update")).toEqual([]);
        expect(JSON.stringify(foreign.frames)).not.toMatch(/owner-only|private\.txt/u);

        await assertReplay(owner, sessionId, version);
        expect(app.model.complete).toHaveBeenCalledTimes(modelCount);
        expect(app.tools.call).toHaveBeenCalledTimes(toolCount);
        expect(app.controller.acquireRun).toHaveBeenCalledTimes(acquireCount);
      },
    );

    it.each(["revision", "principal deactivation"])(
      "rechecks %s on an existing connection without accepting rejected work",
      async (change) => {
        const owner = await app.connect(version);
        const sessionId = await createSession(owner);
        await completePrompt(owner, sessionId, version);
        const original = app.identities.get("owner");
        if (original === undefined) throw new Error("Missing fixture identity");
        app.identities.set("owner-alias", { ...original });
        app.authorizations.set("principal-1:agent-1", {
          active: change === "revision",
          accessRevision: change === "revision" ? "access-2" : "access-1",
        });
        const expectedCode = change === "revision" ? "connection_binding_stale" : "access_denied";
        const expectedWireCode = change === "revision" ? -32020 : -32021;
        const before = await boundaryState(pool);
        const frameOffset = owner.frames.length;
        const modelCount = app.model.complete.mock.calls.length;
        const toolCount = app.tools.call.mock.calls.length;

        for (const [method, params] of [
          ["session/new", { cwd: "/workspace", mcpServers: [] }],
          ["session/list", {}],
          ...sessionCommands(version, sessionId).filter(([method]) => method !== "session/prompt"),
        ] as Array<[string, Record<string, unknown>]>) {
          expectDenied(await owner.request(method, params), expectedCode, expectedWireCode);
        }
        await rejectedCancellation(app, owner, sessionId, expectedCode);
        expect(await boundaryState(pool)).toEqual(before);

        expectDenied(
          await owner.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "rejected-private-prompt" }],
          }),
          "access_denied",
          -32021,
        );
        const after = await boundaryState(pool);
        expect(after.acp_sessions).toEqual(before.acp_sessions);
        expect(after.client_mcp_revisions).toEqual(before.client_mcp_revisions);
        expect(after.session_messages).toEqual(before.session_messages);
        expect(after.tool_attempts).toEqual(before.tool_attempts);
        const rejected = await pool.query(
          "SELECT state, execution_snapshot, admission_id, pending_prompt FROM runs WHERE state <> 'completed'",
        );
        expect(rejected.rows).toEqual([
          { state: "failed", execution_snapshot: null, admission_id: null, pending_prompt: null },
        ]);
        expect(app.model.complete).toHaveBeenCalledTimes(modelCount);
        expect(app.tools.call).toHaveBeenCalledTimes(toolCount);
        expect(app.controller.finishRun).toHaveBeenCalledTimes(1);
        expect(app.recoveryRequired).not.toHaveBeenCalled();
        expect(
          owner.frames.slice(frameOffset).filter((frame) => frame.method === "session/update"),
        ).toEqual([]);

        app.authorizations.set("principal-1:agent-1", { active: true, accessRevision: "access-2" });
        const fresh = await app.connect(version);
        await assertReplay(fresh, sessionId, version);
        expect(JSON.stringify(fresh.frames)).not.toContain("rejected-private-prompt");
        expect(app.model.complete).toHaveBeenCalledTimes(modelCount);
        expect(app.tools.call).toHaveBeenCalledTimes(toolCount);
        await completePrompt(fresh, sessionId, version);
        expect(app.controller.acquireRun).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agentId: "agent-1",
            principalId: "principal-1",
            expectedAccessRevision: "access-2",
          }),
          expect.any(AbortSignal),
        );
        expect(app.model.complete).toHaveBeenCalledTimes(modelCount + 1);
      },
    );

    it.each(["other-user", "other-agent", "revision", "principal deactivation"])(
      "protects an active Run from %s",
      async (change) => {
        const owner = await app.connect(version);
        const sessionId = await createSession(owner);
        const foreign = await app.connect(version, change.startsWith("other-") ? change : "owner");
        const release = Promise.withResolvers<void>();
        let executionSignal: AbortSignal | undefined;
        app.model.complete.mockReset().mockImplementation(async ({ signal }) => {
          executionSignal = signal;
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
        try {
          await expect.poll(() => executionSignal).toBeDefined();
          if (change === "revision" || change === "principal deactivation") {
            app.authorizations.set("principal-1:agent-1", {
              active: change === "revision",
              accessRevision: "access-2",
            });
          } else {
            expectDenied(
              await foreign.request("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "foreign prompt while owner runs" }],
              }),
              "session_access_denied",
              -32020,
            );
          }
          const before = await boundaryState(pool);
          await rejectedCancellation(
            app,
            foreign,
            sessionId,
            change === "revision"
              ? "connection_binding_stale"
              : change === "principal deactivation"
                ? "access_denied"
                : "session_access_denied",
          );
          expect(executionSignal?.aborted).toBe(false);
          expect(await boundaryState(pool)).toEqual(before);
          expect(app.model.complete).toHaveBeenCalledTimes(1);
          expect(app.controller.acquireRun).toHaveBeenCalledTimes(1);
          const current = await pool.query("SELECT state, cancel_requested_at FROM runs");
          expect(current.rows).toEqual([{ state: "running", cancel_requested_at: null }]);
        } finally {
          release.resolve();
          const settled = await prompt;
          expect(settled).toHaveProperty("response");
          if ("response" in settled) expect(settled.response.error).toBeUndefined();
        }
        await expect
          .poll(async () => (await pool.query<{ state: string }>("SELECT state FROM runs")).rows)
          .toEqual([{ state: "completed" }]);
        expect(app.controller.finishRun).toHaveBeenCalledWith(
          expect.objectContaining({
            terminalClass: "completed",
          }),
          expect.any(AbortSignal),
        );
      },
    );
  });
});

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
