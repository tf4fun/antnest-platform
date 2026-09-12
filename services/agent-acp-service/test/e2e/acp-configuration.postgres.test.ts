import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { PostgresSessionConfiguration } from "../../src/adapters/postgres/session-configuration.js";
import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "../../src/adapters/postgres/execution-repository.js";
import { PostgresRunRepository } from "../../src/adapters/postgres/run-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { configurationView } from "../../src/domain/session-configuration.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { configurationCatalog, snapshot } from "../support/fixtures.js";
import type { AcpWireClient } from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const schemas = [v1Schema, v2Schema];
function validate(version: 1 | 2, definition: string, value: unknown) {
  const schema = schemas[version - 1]!;
  const validator = new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: `#/$defs/${definition}`,
    $defs: schema.$defs,
  });
  expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
}
function options(result: Record<string, unknown> | undefined) {
  return result?.configOptions as
    | Array<{
        id?: string;
        configId?: string;
        currentValue: string;
        options: Array<{ value: string }>;
      }>
    | undefined;
}
function selected(result: Record<string, unknown> | undefined, id: string) {
  return options(result)?.find((option) => (option.id ?? option.configId) === id)?.currentValue;
}
function set(
  client: AcpWireClient,
  version: 1 | 2,
  sessionId: string,
  configId: string,
  value: string | boolean,
) {
  return client.request("session/set_config_option", {
    sessionId,
    configId,
    value,
    ...(typeof value === "boolean" ? { type: "boolean" } : version === 2 ? { type: "id" } : {}),
  });
}

describe.skipIf(databaseUrl === undefined)("ACP configuration over protocol and PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    app.model.complete.mockReset().mockResolvedValue({
      kind: "message",
      content: [{ type: "text", text: "reply" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await pool.end();
  });

  for (const version of [1, 2] as const) {
    it(`v${version}: config writes, broadcasts, reconnects, forks and inherit resets use official shapes`, async () => {
      const client = await app.connect(version);
      const created = await client.request("session/new", setup);
      expect(created.error).toBeUndefined();
      validate(version, "NewSessionResponse", created.result);
      const sessionId = String(created.result?.sessionId);
      expect(selected(created.result, "model")).toBe("agent_default");
      expect(selected(created.result, "mode")).toBe("agent_default");
      const observer = await app.connect(version === 1 ? 2 : 1);
      await observer.request("session/resume", { ...setup, sessionId });
      const changed = await set(client, version, sessionId, "mode", "chat");
      expect(changed.error).toBeUndefined();
      validate(version, "SetSessionConfigOptionResponse", changed.result);
      expect(selected(changed.result, "mode")).toBe("chat");
      expect(options(changed.result)).toHaveLength(2);
      await expect
        .poll(
          () =>
            observer.frames.filter(
              (frame) => frame.params?.update?.sessionUpdate === "config_option_update",
            ).length,
        )
        .toBe(1);
      for (const frame of client.frames.filter(
        (frame) => frame.params?.update?.sessionUpdate === "config_option_update",
      )) {
        validate(version, "SessionUpdate", frame.params?.update);
        expect(frame.params?.update?.configOptions).toEqual(changed.result?.configOptions);
      }
      if (version === 1) {
        const mode = await client.request("session/set_mode", { sessionId, modeId: "auto" });
        expect(mode.result).toEqual({});
        expect(client.frames.at(-2)?.params?.update).toMatchObject({
          sessionUpdate: "current_mode_update",
          currentModeId: "auto",
        });
      }
      await set(client, version, sessionId, "model", "profile:profile-1");
      await client.close();
      const reconnected = await app.connect(version);
      const resumed = await reconnected.request(version === 1 ? "session/load" : "session/resume", {
        ...setup,
        sessionId,
        ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
      });
      expect(resumed.error).toBeUndefined();
      validate(
        version,
        version === 1 ? "LoadSessionResponse" : "ResumeSessionResponse",
        resumed.result,
      );
      expect(selected(resumed.result, "model")).toBe("profile:profile-1");
      expect(
        reconnected.frames.filter(
          (frame) => frame.params?.update?.sessionUpdate === "config_option_update",
        ),
      ).toHaveLength(0);
      const fork = await reconnected.request("session/fork", { ...setup, sessionId });
      expect(fork.error).toBeUndefined();
      validate(version, "ForkSessionResponse", fork.result);
      expect(selected(fork.result, "model")).toBe("profile:profile-1");
      const forkId = String(fork.result?.sessionId);
      await set(reconnected, version, forkId, "model", "agent_default");
      const repository = new PostgresSessionConfiguration(new PostgresKernel(pool));
      expect((await repository.get(sessionId)).configuration.modelProfileId).toBe("profile-1");
      expect((await repository.get(forkId)).configuration.modelProfileId).toBeUndefined();
      expect(
        (await new PostgresContextRepository(new PostgresKernel(pool)).load(sessionId)).messages,
      ).toEqual([]);
    });

    it(`v${version}: rejects invalid/foreign choices and live identity revocation without a successful update`, async () => {
      const client = await app.connect(version);
      const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
      for (const [id, value] of [
        ["model", "foreign"],
        ["mode", false],
        ["mode", "root"],
      ] as const)
        expect((await set(client, version, sessionId, id, value)).error).toBeDefined();
      const other = await app.connect(version, "other-user");
      expect((await set(other, version, sessionId, "mode", "chat")).error?.data?.code).toBe(
        "session_access_denied",
      );
      app.authorizations.get("principal-1:agent-1")!.active = false;
      expect((await set(client, version, sessionId, "mode", "chat")).error?.data?.code).toBe(
        "access_denied",
      );
      const stored = await new PostgresSessionConfiguration(new PostgresKernel(pool)).get(
        sessionId,
      );
      expect(stored).toEqual({ configuration: {}, revision: 0 });
      expect(
        client.frames.filter(
          (frame) => frame.params?.update?.sessionUpdate === "config_option_update",
        ),
      ).toHaveLength(0);
    });
  }

  it("bounds configuration lock waits without losing the connection or blocking reads", async () => {
    const client = await app.connect(1);
    const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
    const repository = new PostgresSessionConfiguration(new PostgresKernel(pool));
    const blocker = await pool.connect();
    const configuration = { authorizationMode: "chat" as const };
    const input = {
      sessionId,
      expectedRevision: 0,
      configuration,
      view: configurationView(configuration, configurationCatalog()),
      changedAt: new Date(),
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let attempted: Promise<unknown> | undefined;
    let outcome: unknown;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM acp_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
      attempted = repository.save(input).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((await repository.get(sessionId)).revision).toBe(0);
      outcome = await Promise.race([
        attempted,
        new Promise<Error>((resolve) => {
          deadline = setTimeout(
            () => resolve(new Error("Configuration lock did not time out")),
            9000,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      await blocker.query("ROLLBACK");
      blocker.release();
      await attempted;
    }
    expect(outcome).toMatchObject({ code: "55P03" });
    await repository.save(input);
    expect((await repository.get(sessionId)).revision).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM session_messages WHERE kind = 'configuration'",
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  }, 15000);

  it("captures admission overrides under the Session lock and preserves them on recovery", async () => {
    const client = await app.connect(1);
    const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
    await set(client, 1, sessionId, "mode", "chat");
    const kernel = new PostgresKernel(pool);
    const runs = new PostgresRunRepository(kernel);
    const intent = await runs.createRunIntent({
      runId: "run-1",
      requestId: "request-1",
      sessionId,
      expectedAccessRevision: "access-1",
      userMessageId: "user-1",
      prompt: [{ type: "text", text: "hello" }],
      createdAt: new Date(),
    });
    await set(client, 1, sessionId, "mode", "auto");
    expect(intent.sessionConfiguration).toEqual({ authorizationMode: "chat" });
    const executions = new PostgresExecutionRepository(kernel);
    expect((await executions.listRecoveryWork())[0]).toMatchObject({
      kind: "admitting",
      sessionConfiguration: { authorizationMode: "chat" },
    });
    const frozen = snapshot();
    frozen.clientMcpRevisionId = intent.clientMcpRevisionId;
    frozen.executionSpec.configuration = {
      modelProfileId: "profile-1",
      modelProfileRevisionId: "revision-1",
      authorization: { mode: "chat", toolRules: [] },
      authorizationRevision: 1,
      digest: "c".repeat(64),
    };
    await runs.acceptRun({
      runId: intent.id,
      snapshot: frozen,
      environmentFact: null,
      acceptedAt: new Date(),
    });
    expect((await executions.listRecoveryWork())[0]).toMatchObject({
      kind: "running",
      snapshot: { executionSpec: { configuration: frozen.executionSpec.configuration } },
    });
  });

  it("applies a model and mode change to the next Run, without replacing active credentials or Runtime", async () => {
    const catalog = configurationCatalog();
    catalog.models.push({
      ...catalog.models[0]!,
      modelProfileId: "profile-2",
      revisionId: "revision-2",
      model: "other-model",
      displayName: "Other provider",
      contextWindow: 96000,
      supportsImages: true,
    });
    app.controller.getSessionConfiguration.mockResolvedValue(catalog);
    app.controller.acquireRun.mockImplementation((input) => {
      const frozen = snapshot();
      const alternate = input.sessionConfiguration?.modelProfileId === "profile-2";
      frozen.admissionId = `admission-${input.requestId}`;
      frozen.admissionDeadline = new Date(Date.now() + 60000);
      if (alternate) {
        frozen.executionSpec.model = {
          ...frozen.executionSpec.model,
          model: "other-model",
          baseUrl: "https://other-provider.test/v1",
          contextWindow: 96000,
          supportsImages: true,
        };
        frozen.executionSpec.credentialRef = "other-credential";
        frozen.credentialVersion = "other-version";
      }
      frozen.executionSpec.configuration = {
        modelProfileId: alternate ? "profile-2" : "profile-1",
        modelProfileRevisionId: alternate ? "revision-2" : "revision-1",
        authorization: {
          mode: input.sessionConfiguration?.authorizationMode ?? "auto",
          toolRules: [],
        },
        authorizationRevision: 1,
        digest: (alternate ? "d" : "c").repeat(64),
      };
      return Promise.resolve(frozen);
    });
    app.controller.resolveCredential.mockImplementation((input) =>
      Promise.resolve({
        secretType: "bearer",
        secret: input.credentialRef === "other-credential" ? "other-secret" : "original-secret",
        credentialVersion:
          input.credentialRef === "other-credential" ? "other-version" : "credential-version-1",
      }),
    );
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reply = {
      kind: "message" as const,
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    app.model.complete.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return reply;
    });
    const client = await app.connect(1);
    const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
    const first = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "first" }],
    });
    try {
      await started.promise;
      await set(client, 1, sessionId, "model", "profile:profile-2");
      await set(client, 1, sessionId, "mode", "chat");
      expect(app.model.complete.mock.calls[0]?.[0]).toMatchObject({
        credential: "original-secret",
        snapshot: {
          executionSpec: {
            model: { model: "example-model" },
            configuration: { authorization: { mode: "auto" } },
          },
        },
      });
    } finally {
      release.resolve();
    }
    expect((await first).result).toEqual({ stopReason: "end_turn" });
    expect(
      (
        await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "second" }],
        })
      ).result,
    ).toEqual({ stopReason: "end_turn" });
    const second = app.model.complete.mock.calls[1]?.[0];
    expect(second).toMatchObject({
      credential: "other-secret",
      tools: [],
      snapshot: {
        credentialVersion: "other-version",
        executionSpec: {
          credentialRef: "other-credential",
          model: { model: "other-model", contextWindow: 96000, supportsImages: true },
          configuration: { authorization: { mode: "chat" } },
        },
      },
    });
    expect(second?.snapshot.runtime).toEqual(
      app.model.complete.mock.calls[0]?.[0].snapshot.runtime,
    );
    expect(app.tools.list).toHaveBeenCalledOnce();
  });

  it("commits revision and notification together, rejects conflicts, and keeps fork event IDs distinct", async () => {
    const client = await app.connect(1);
    const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
    const repository = new PostgresSessionConfiguration(new PostgresKernel(pool));
    const configuration = { authorizationMode: "chat" as const };
    const input = {
      sessionId,
      expectedRevision: 0,
      configuration,
      view: configurationView(configuration, configurationCatalog()),
      changedAt: new Date(),
    };
    await repository.save(input);
    await expect(repository.save(input)).rejects.toMatchObject({ code: "configuration_conflict" });
    expect((await repository.get(sessionId)).revision).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM session_messages WHERE kind = 'configuration'",
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    await pool.query("UPDATE acp_sessions SET state = 'deleted' WHERE id = $1", [sessionId]);
    await expect(repository.save({ ...input, expectedRevision: 1 })).rejects.toThrow();
  });
});
