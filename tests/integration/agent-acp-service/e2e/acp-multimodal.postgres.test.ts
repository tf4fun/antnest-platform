import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { identityHeaders } from "../../../../services/agent-acp-service/test/support/fixtures.js";
import {
  audio,
  audioData,
  pdf,
  pdfData,
} from "../../../../services/agent-acp-service/test/fixtures/multimodal.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const prompt = [
  { type: "text", text: "Summarize the attachments" },
  audio,
  pdf,
];

describe.skipIf(databaseUrl === undefined)(
  "ACP native input with PostgreSQL",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
    const httpConnections: acp.ClientConnection[] = [];
    const fetchFn =
      vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    let nativeEnabled = true;

    async function configure() {
      app.configuration.models[0]!.supports_audio = nativeEnabled;
      app.configuration.models[0]!.supports_pdf = nativeEnabled;
      await app.publishConfiguration();
      const provider = new OpenAICompatibleModel({ fetchFn });
      app.model.complete
        .mockReset()
        .mockImplementation((request) => provider.complete(request));
    }

    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      nativeEnabled = true;
      // Each completion consumes its own response body, just like an actual HTTP request.
      fetchFn.mockReset().mockImplementation(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "native response" },
              },
            ],
          }),
        ),
      );
      app = await startBoundaryApplication(pool);
      await configure();
    });
    afterEach(async () => {
      for (const connection of httpConnections.splice(0)) connection.close();
      await app.close();
    });
    afterAll(async () => {
      await pool.end();
    });

    async function waitState(sessionId: string, state: string) {
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ state: string }>(
                "SELECT state FROM runs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1",
                [sessionId],
              )
            ).rows[0]?.state,
        )
        .toBe(state);
      await expect.poll(() => app.finish.mock.calls.length).toBeGreaterThan(0);
    }

    function expectNativeRequest() {
      const body = fetchFn.mock.calls.at(-1)?.[1].body;
      if (typeof body !== "string")
        throw new Error("Provider request was not executed");
      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(parsed.messages).toContainEqual({
        role: "user",
        content: [
          { type: "text", text: "Summarize the attachments" },
          {
            type: "input_audio",
            input_audio: { data: audioData, format: "wav" },
          },
          { type: "text", text: "Embedded resource: attachment:///report.pdf" },
          {
            type: "file",
            file: {
              filename: "attachment.pdf",
              file_data: `data:application/pdf;base64,${pdfData}`,
            },
          },
        ],
      });
    }

    it.each([1, 2] as const)(
      "v%s consumes, persists, restores and forks native attachments",
      async (version) => {
        const client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        expect(
          (await client.request("session/prompt", { sessionId, prompt })).error,
        ).toBeUndefined();
        await waitState(sessionId, "completed");
        expectNativeRequest();
        const history = await app.sessions.readOutput(sessionId, 0);
        expect(
          history.events.find((event) => event.kind === "user_message"),
        ).toMatchObject({
          content: prompt,
        });
        await app.close();
        app = await startBoundaryApplication(pool);
        await configure();
        const restored = await app.connect(version);
        const result = await restored.request(
          version === 1 ? "session/load" : "session/resume",
          {
            ...setup,
            sessionId,
            ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
          },
        );
        expect(result.error).toBeUndefined();
        const replay = JSON.stringify(restored.frames);
        expect(replay).toContain(audioData);
        expect(replay).toContain(pdfData);
        const forked = await restored.request("session/fork", {
          ...setup,
          sessionId,
        });
        expect(forked.error).toBeUndefined();
        const forkId = String(forked.result?.sessionId);
        expect(
          (
            await restored.request("session/prompt", {
              sessionId: forkId,
              prompt: [{ type: "text", text: "continue" }],
            })
          ).error,
        ).toBeUndefined();
        await waitState(forkId, "completed");
        expectNativeRequest();
        expect(fetchFn).toHaveBeenCalledTimes(2);
        const other = await app.connect(version, "other-agent");
        expect(
          (await other.request("session/resume", { ...setup, sessionId })).error
            ?.data?.code,
        ).toBe("session_access_denied");
      },
    );

    it.each([1, 2] as const)(
      "v%s closes a model mismatch without a Provider request and permits a new Run",
      async (version) => {
        nativeEnabled = false;
        await configure();
        const client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        await client.request("session/prompt", { sessionId, prompt });
        await waitState(sessionId, "failed");
        expect(fetchFn).not.toHaveBeenCalled();
        expect(app.finish).toHaveBeenCalledWith(
          expect.objectContaining({
            terminalClass: "failed",
            toolEffectState: "none",
            errorClass: "model_unsupported_content",
          }),
        );
        nativeEnabled = true;
        app.configuration.models[0]!.supports_audio = true;
        app.configuration.models[0]!.supports_pdf = true;
        await app.publishConfiguration();
        expect(
          (
            await client.request("session/prompt", {
              sessionId,
              prompt: [
                { type: "text", text: "retry using the supported model" },
              ],
            })
          ).error,
        ).toBeUndefined();
        await waitState(sessionId, "completed");
        expectNativeRequest();
        expect(fetchFn).toHaveBeenCalledTimes(1);
      },
    );

    it("v1 HTTP negotiates audio and forwards it through the same durable execution path", async () => {
      const connection = acp.client().connect(
        createHttpStream(app.httpUrl, {
          headers: identityHeaders(),
        }),
      );
      httpConnections.push(connection);
      const initialized = await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
        },
      );
      expect(initialized.agentCapabilities?.promptCapabilities?.audio).toBe(
        true,
      );
      const session = await connection.agent.request<acp.NewSessionResponse>(
        acp.methods.agent.session.new,
        setup,
      );
      const result = await connection.agent.request<acp.PromptResponse>(
        acp.methods.agent.session.prompt,
        { sessionId: session.sessionId, prompt: prompt as acp.ContentBlock[] },
      );
      expect(result.stopReason).toBe("end_turn");
      await waitState(session.sessionId, "completed");
      expectNativeRequest();
    });
  },
);
