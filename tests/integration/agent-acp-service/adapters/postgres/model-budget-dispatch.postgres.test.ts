import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { OpenAICompatibleModel } from "../../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { DurableRunEvents } from "../../../../../services/agent-acp-service/src/application/durable-run-events.js";
import { ModelCallPolicy } from "../../../../../services/agent-acp-service/src/application/model-call-policy.js";
import { ModelRequestBudget } from "../../../../../services/agent-acp-service/src/application/model-request-budget.js";
import { ProviderClients } from "../../../../../services/agent-acp-service/src/application/provider-clients.js";
import { RunModelClient } from "../../../../../services/agent-acp-service/src/application/run-model-client.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import type { RunBudget } from "../../../../../services/agent-acp-service/src/domain/model-budget.js";
import { runSnapshot } from "../../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import type {
  ModelRequest,
  ModelResult,
} from "../../../../../services/agent-acp-service/src/ports/model.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  type FencingFixture,
  duration,
  registration,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const organizationId = "organization-1";
const secrets = ["synthetic-budget-provider-a", "synthetic-budget-provider-b"];
type Reservation = {
  ordinal: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_usd_micros: string | null;
  state: string;
  cost_unknown: boolean;
};
type Totals = {
  input_tokens: string;
  output_tokens: string;
  cost_usd_micros: string;
  reserved_input_tokens: string;
  reserved_output_tokens: string;
  reserved_cost_usd_micros: string;
  unknown_attempts: string;
};
type Spend = {
  period: string;
  cost_usd_micros: string;
  reserved_cost_usd_micros: string;
  unknown_attempts: string;
};
type Audit = {
  kind: string;
  visible: boolean;
  context_excluded: boolean;
  payload: Record<string, unknown>;
};
type Captured = {
  body: Record<string, unknown>;
  reservations: Reservation[];
  audits: Audit[];
};

async function ledger(db: FencingFixture, runId: string) {
  const [reservations, usage, spend] = await Promise.all([
    db.observer.query<Reservation>(
      "SELECT ordinal::text,input_tokens::text,output_tokens::text,cost_usd_micros::text,state,cost_unknown FROM model_budget_reservations WHERE run_id=$1 ORDER BY ordinal",
      [runId],
    ),
    db.observer.query<Totals>(
      "SELECT input_tokens::text,output_tokens::text,cost_usd_micros::text,reserved_input_tokens::text,reserved_output_tokens::text,reserved_cost_usd_micros::text,unknown_attempts::text FROM run_usage WHERE run_id=$1",
      [runId],
    ),
    db.observer.query<Spend>(
      "SELECT period,cost_usd_micros::text,reserved_cost_usd_micros::text,unknown_attempts::text FROM organization_spend WHERE organization_id=$1 ORDER BY period,period_start",
      [organizationId],
    ),
  ]);
  return {
    reservations: reservations.rows,
    usage: usage.rows,
    spend: spend.rows,
  };
}

async function audits(db: FencingFixture, runId: string): Promise<Audit[]> {
  return (
    await db.observer.query<Audit>(
      "SELECT kind,visible,context_excluded,payload FROM session_messages WHERE run_id=$1 AND kind IN ('model_attempt','usage') ORDER BY sequence",
      [runId],
    )
  ).rows;
}

function expectSpend(
  rows: Spend[],
  cost: string,
  reserved: string,
  unknown: string,
): void {
  expect(new Set(rows.map((row) => row.period))).toEqual(
    new Set(["daily", "monthly"]),
  );
  for (const period of ["daily", "monthly"]) {
    const bucket = rows.filter((row) => row.period === period);
    const sum = (
      field:
        "cost_usd_micros" | "reserved_cost_usd_micros" | "unknown_attempts",
    ) =>
      bucket.reduce((total, row) => total + BigInt(row[field]), 0n).toString();
    expect(sum("cost_usd_micros")).toBe(cost);
    expect(sum("reserved_cost_usd_micros")).toBe(reserved);
    expect(sum("unknown_attempts")).toBe(unknown);
  }
}

async function end(
  response: ServerResponse,
  status: number,
  payload: unknown,
): Promise<void> {
  response.writeHead(status, {
    "content-type": "application/json",
    "retry-after": "0",
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("finish", finished);
      response.off("error", failed);
      response.off("close", closed);
    };
    const finished = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => {
      if (!response.writableFinished)
        failed(new Error("Original model response closed before finish"));
    };
    response.once("finish", finished);
    response.once("error", failed);
    response.once("close", closed);
    response.end(JSON.stringify(payload));
  });
}

async function withChain(
  options: {
    unknownCost?: "allow" | "deny";
    runBudget?: RunBudget;
    image?: boolean;
    fallback?: boolean;
    noSend?: "cancel" | "rotate";
    noPricing?: boolean;
  },
  work: (fixture: {
    db: FencingFixture;
    runId: string;
    request: ModelRequest;
    captures: Captured[];
    complete: () => Promise<ModelResult>;
    preparations: MockInstance<RunModelClient["prepare"]>;
  }) => Promise<void>,
): Promise<void> {
  await withDatabase(async (db) => {
    const failures: unknown[] = [];
    const originals: Promise<ModelResult>[] = [];
    const handlers: Promise<void>[] = [];
    const sockets = new Set<Socket>();
    const socketJoins: Promise<void>[] = [];
    const captures: Captured[] = [];
    const stop = new AbortController();
    let runId: string | undefined;
    const server = createServer((incoming, response) => {
      const task = (async () => {
        expect(incoming.method).toBe("POST");
        expect(incoming.url).toBe("/v1/chat/completions");
        const chunks: Buffer[] = [];
        for await (const chunk of incoming)
          chunks.push(Buffer.from(chunk as Uint8Array));
        const parsed: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        )
          throw new Error("Expected an original JSON model request");
        const body = parsed as Record<string, unknown>;
        const index =
          body.model === "budget-model-a"
            ? 0
            : body.model === "budget-model-b"
              ? 1
              : -1;
        if (index < 0 || runId === undefined)
          throw new Error("Unexpected Provider dispatch");
        expect(incoming.headers.authorization).toBe("Bearer " + secrets[index]);
        const [committed, events] = await Promise.all([
          ledger(db, runId),
          audits(db, runId),
        ]);
        captures.push({
          body,
          reservations: committed.reservations,
          audits: events,
        });
        expect(captures.length).toBeLessThanOrEqual(options.fallback ? 2 : 1);
        expect(committed.reservations.at(-1)?.state).toBe("reserved");
        if (options.fallback && index === 0) {
          await end(response, 429, {
            error: { message: "synthetic Provider throttling" },
          });
        } else {
          await end(response, 200, {
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "completed" },
              },
            ],
            usage: { prompt_tokens: 80, completion_tokens: 20 },
          });
        }
      })().catch((error: unknown) => {
        failures.push(error);
        response.destroy();
      });
      handlers.push(task);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socketJoins.push(
        new Promise<void>((resolve) =>
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
    });
    const collect = async (task: Promise<unknown>): Promise<void> => {
      try {
        await task;
      } catch (error) {
        failures.push(error);
      }
    };
    let restorePreparation: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Model listener did not start");
      const baseUrl = "http://127.0.0.1:" + address.port + "/v1";
      const seed = executionConfiguration();
      const provider = seed.providers[0]!;
      const model = seed.models[0]!;
      const agent = seed.agents[0]!;
      const count = options.fallback ? 2 : 1;
      const configuration = parseExecutionConfiguration({
        ...seed,
        providers: Array.from({ length: count }, (_, index) => ({
          ...provider,
          connection_id: index === 0 ? "provider-1" : "provider-2",
          base_url: baseUrl,
          credential_revision: "credential-1",
          credential: { method: "api_key", secret: secrets[index] },
        })),
        models: Array.from({ length: count }, (_, index) => ({
          ...model,
          model_profile_id: index === 0 ? "model-1" : "model-2",
          connection_id: index === 0 ? "provider-1" : "provider-2",
          model: index === 0 ? "budget-model-a" : "budget-model-b",
          context_window: 64_000,
          max_output_tokens: index === 0 ? 64 : 32,
          supports_images: true,
          pricing: options.noPricing
            ? undefined
            : { currency: "USD", input_per_million: 1, output_per_million: 1 },
          provider_token_limits: {
            source: "models",
            source_revision: 1,
            binding: {
              organization_id: organizationId,
              connection_id: index === 0 ? "provider-1" : "provider-2",
              provider_key: provider.provider_key,
              request_protocol: provider.request_protocol,
              base_url: baseUrl,
              model: index === 0 ? "budget-model-a" : "budget-model-b",
              credential_revision: "credential-1",
            },
            context_tokens: index === 0 ? 8192 : 4096,
            max_output_tokens: index === 0 ? 64 : 32,
            output_includes_reasoning: true,
          },
        })),
        agents: [
          {
            ...agent,
            run_budget: options.runBudget ?? {},
            model_retry: { max: 0, base_ms: 1, cap_ms: 1 },
            failover: options.fallback ? "before_output" : "never",
            fallback_model_profile_ids: options.fallback ? ["model-2"] : [],
          },
        ],
        organization_budget: {
          revision: 1,
          unknown_cost: options.unknownCost ?? "allow",
          run_caps: {},
          daily: {},
          monthly: {},
        },
      });
      const published = publicExecutionConfiguration(configuration);
      await db.observer.query(
        "INSERT INTO execution_configurations(organization_id,revision,configuration) VALUES($1,$2,$3::jsonb)",
        [organizationId, published.revision, JSON.stringify(published)],
      );
      const stored = (
        await db.observer.query<{ configuration: unknown }>(
          "SELECT configuration FROM execution_configurations WHERE organization_id=$1",
          [organizationId],
        )
      ).rows[0]!.configuration;
      for (const secret of secrets)
        expect(JSON.stringify(stored)).not.toContain(secret);
      const session = await db.session(scope(agent.agent_id, organizationId));
      const owner = await db.owner(session.binding, registration("acp-a"));
      const repositories = createOwnedRunRepositories(
        db.kernelA,
        owner.authority,
      );
      const intent = db.input(session);
      runId = intent.runId;
      await repositories.runs.createRunIntent(intent);
      const frozen = runSnapshot({
        configuration: published,
        identity: session.binding,
        overrides: {},
        accessRevision: agent.access_revision,
        clientMcpRevisionId: session.mcpRevisionId,
        deadlineAt: new Date(Date.now() + 60_000),
      });
      expect(
        await repositories.runs.acceptRun({
          runId,
          snapshot: frozen,
          environmentFact: null,
          acceptedAt: new Date(),
        }),
      ).toBe("accepted");
      const providers = new ProviderClients(
        new OpenAICompatibleModel({
          destination: { allowPrivateEndpoints: true },
        }),
      );
      providers.apply(configuration);
      const client = new RunModelClient({ providers, snapshot: frozen });
      const preparations = vi.spyOn(client, "prepare");
      restorePreparation = () => preparations.mockRestore();
      const events = new DurableRunEvents({
        repository: repositories.events,
        publish: () => Promise.resolve(),
        id: () => randomUUID(),
        now: () => new Date(),
        contextSize: frozen.executionSpec.model.contextWindow,
        ownershipSignal: new AbortController().signal,
      });
      const policy = new ModelCallPolicy({
        model: client,
        attempts: {
          start: async (id, fact) => {
            await events.start(id, fact);
            if (options.noSend === "cancel")
              stop.abort(new Error("cancel after committed reservation"));
            if (options.noSend === "rotate") {
              const changed = structuredClone(configuration);
              changed.revision += 1;
              changed.providers = changed.providers.map((provider) =>
                provider.enabled
                  ? {
                      ...provider,
                      credential_revision: "credential-2",
                      credential: {
                        method: "api_key",
                        secret: "synthetic-rotated-key",
                      },
                    }
                  : provider,
              );
              providers.apply(changed);
            }
          },
          finish: (id, fact) => events.finish(id, fact),
        },
        budget: new ModelRequestBudget(frozen.executionSpec.maxModelRequests),
      });
      const request: ModelRequest = {
        snapshot: frozen,
        messages: [
          {
            role: "user",
            content: options.image
              ? [
                  {
                    type: "image",
                    mimeType: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=",
                  },
                ]
              : [{ type: "text", text: "Complete this original request" }],
          },
        ],
        tools: [],
        signal: stop.signal,
      };
      const complete = () => {
        const original = policy.complete({ runId: intent.runId, request });
        originals.push(original);
        void original.catch(() => undefined);
        return original;
      };
      await work({
        db,
        runId: intent.runId,
        request,
        captures,
        complete,
        preparations,
      });
    } catch (error) {
      failures.push(error);
    } finally {
      stop.abort(new Error("Model budget component fixture is closing"));
      await Promise.allSettled(originals);
      // Failure here remains a cleanup failure; forced teardown below cannot
      // stand in for the original per-completion transport close.
      await collect(expect.poll(() => sockets.size, { timeout: 2000 }).toBe(0));
      restorePreparation?.();
      if (server.listening) {
        const closing = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await collect(closing);
      }
      await Promise.all(handlers);
      await Promise.all(socketJoins);
      try {
        expect(server.address()).toBeNull();
        expect(sockets.size).toBe(0);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Model budget dispatch or original cleanup failed",
      );
  });
}

describe.skipIf(databaseUrl === undefined)(
  "prepared model budget dispatch with real HTTP and PostgreSQL",
  () => {
    it.each([
      { noSend: "cancel", noPricing: false },
      { noSend: "rotate", noPricing: false },
      { noSend: "cancel", noPricing: true },
      { noSend: "rotate", noPricing: true },
    ] as const)(
      "releases committed reservations for $noSend without dispatch (noPricing=$noPricing)",
      async (scenario) => {
        await withChain({ ...scenario, unknownCost: "allow" }, async (f) => {
          await expect(f.complete()).rejects.toThrow();
          expect(f.captures).toEqual([]);
          const saved = await ledger(f.db, f.runId);
          expect(saved.reservations).toHaveLength(1);
          expect(saved.reservations[0]).toMatchObject({
            state: "settled",
            cost_unknown: false,
          });
          expect(saved.usage[0]).toEqual({
            input_tokens: "0",
            output_tokens: "0",
            cost_usd_micros: "0",
            reserved_input_tokens: "0",
            reserved_output_tokens: "0",
            reserved_cost_usd_micros: "0",
            unknown_attempts: "0",
          });
          expectSpend(saved.spend, "0", "0", "0");
          const finish = (await audits(f.db, f.runId)).find(
            (row) => row.payload.phase === "finish",
          )!;
          expect(finish.payload).toMatchObject({
            notDispatched: true,
            usage: { inputTokens: 0, outputTokens: 0 },
          });
          expect(finish.payload.usage).not.toHaveProperty("cost");
        });
      },
      duration,
    );

    it(
      "commits the actual reservation before HTTP and refuses a later call that would exceed the remaining Run budget",
      async () => {
        await withChain(
          { unknownCost: "deny", runBudget: { max_cost_usd_micros: 8300 } },
          async (f) => {
            await expect(f.complete()).resolves.toMatchObject({
              kind: "message",
            });
            expect(f.captures).toHaveLength(1);
            expect(f.captures[0]!.body.max_tokens).toBe(64);
            expect(f.captures[0]!.reservations).toEqual([
              {
                ordinal: "1",
                input_tokens: "8192",
                output_tokens: "64",
                cost_usd_micros: "8256",
                state: "reserved",
                cost_unknown: false,
              },
            ]);
            expect(f.captures[0]!.audits).toHaveLength(1);
            expect(f.captures[0]!.audits[0]).toMatchObject({
              kind: "model_attempt",
              visible: false,
              context_excluded: true,
              payload: {
                phase: "start",
                ordinal: 1,
                reservation: { inputTokens: 8192, outputTokens: 64 },
              },
            });
            const before = await ledger(f.db, f.runId);
            await expect(f.complete()).rejects.toMatchObject({
              code: "budget_exceeded",
              scope: "run_cost",
              retryable: false,
            });
            expect(f.captures).toHaveLength(1);
            expect(await ledger(f.db, f.runId)).toEqual(before);
            expect(before.usage).toEqual([
              {
                input_tokens: "80",
                output_tokens: "20",
                cost_usd_micros: "100",
                reserved_input_tokens: "0",
                reserved_output_tokens: "0",
                reserved_cost_usd_micros: "0",
                unknown_attempts: "0",
              },
            ]);
            expectSpend(before.spend, "100", "0", "0");
            const saved = await audits(f.db, f.runId);
            const attempts = saved.filter(
              (row) => row.kind === "model_attempt",
            );
            expect(
              attempts.map((row) => [row.payload.phase, row.payload.ordinal]),
            ).toEqual([
              ["start", 1],
              ["finish", 1],
            ]);
            expect(saved.filter((row) => row.kind === "usage")).toHaveLength(1);
            expect(f.preparations).toHaveBeenCalledTimes(2);
          },
        );
      },
      duration,
    );

    it.each([
      {
        name: "deny",
        unknownCost: "deny",
        runBudget: {},
        denied: "unknown_cost",
      },
      {
        name: "allow without token caps",
        unknownCost: "allow",
        runBudget: {},
        denied: null,
      },
      {
        name: "allow with an input hard cap",
        unknownCost: "allow",
        runBudget: { max_input_tokens: 100000 },
        denied: "run_input",
      },
    ] as const)(
      "preserves unknown image input for $name",
      async (scenario) => {
        await withChain(
          {
            image: true,
            unknownCost: scenario.unknownCost,
            runBudget: scenario.runBudget,
          },
          async (f) => {
            const before = await ledger(f.db, f.runId);
            if (scenario.denied !== null) {
              await expect(f.complete()).rejects.toMatchObject({
                code: "budget_exceeded",
                scope: scenario.denied,
                retryable: false,
              });
              expect(f.captures).toEqual([]);
              expect((await ledger(f.db, f.runId)).reservations).toEqual([]);
              expect(await ledger(f.db, f.runId)).toEqual(before);
              expect(await audits(f.db, f.runId)).toEqual([]);
            } else {
              await expect(f.complete()).resolves.toMatchObject({
                kind: "message",
              });
              expect(f.captures).toHaveLength(1);
              expect(f.captures[0]!.body.max_tokens).toBe(64);
              expect(f.captures[0]!.reservations).toEqual([
                {
                  ordinal: "1",
                  input_tokens: null,
                  output_tokens: "64",
                  cost_usd_micros: null,
                  state: "reserved",
                  cost_unknown: true,
                },
              ]);
              expect(f.captures[0]!.audits[0]).toMatchObject({
                payload: { phase: "start", reservation: { outputTokens: 64 } },
              });
              expect(
                f.captures[0]!.audits[0]!.payload.reservation,
              ).not.toHaveProperty("inputTokens");
              const after = await ledger(f.db, f.runId);
              expect(after.reservations[0]).toMatchObject({
                input_tokens: null,
                output_tokens: "64",
                state: "settled",
                cost_unknown: false,
              });
              expect(after.usage[0]).toMatchObject({
                input_tokens: "80",
                output_tokens: "20",
                cost_usd_micros: "100",
                reserved_cost_usd_micros: "0",
              });
              expectSpend(after.spend, "100", "0", "0");
              expect(
                (await audits(f.db, f.runId)).map((row) => row.kind),
              ).toEqual(["model_attempt", "model_attempt", "usage"]);
            }
          },
        );
      },
      duration,
    );

    it(
      "keeps an unknown throttled attempt reserved while a separately prepared fallback settles its actual usage",
      async () => {
        await withChain(
          {
            fallback: true,
            unknownCost: "allow",
            runBudget: { max_cost_usd_micros: 15000 },
          },
          async (f) => {
            const deadline = new Date(f.request.snapshot.deadlineAt);
            await expect(f.complete()).resolves.toMatchObject({
              kind: "message",
              content: [{ type: "text", text: "completed" }],
            });
            expect(
              f.captures.map((capture) => [
                capture.body.model,
                capture.body.max_tokens,
              ]),
            ).toEqual([
              ["budget-model-a", 64],
              ["budget-model-b", 32],
            ]);
            expect(f.captures[0]!.reservations).toEqual([
              {
                ordinal: "1",
                input_tokens: "8192",
                output_tokens: "64",
                cost_usd_micros: "8256",
                state: "reserved",
                cost_unknown: false,
              },
            ]);
            expect(f.captures[1]!.reservations).toEqual([
              {
                ordinal: "1",
                input_tokens: "8192",
                output_tokens: "64",
                cost_usd_micros: "8256",
                state: "unresolved",
                cost_unknown: true,
              },
              {
                ordinal: "2",
                input_tokens: "4096",
                output_tokens: "32",
                cost_usd_micros: "4128",
                state: "reserved",
                cost_unknown: false,
              },
            ]);
            const after = await ledger(f.db, f.runId);
            expect(after.reservations).toEqual([
              {
                ordinal: "1",
                input_tokens: "8192",
                output_tokens: "64",
                cost_usd_micros: "8256",
                state: "unresolved",
                cost_unknown: true,
              },
              {
                ordinal: "2",
                input_tokens: "4096",
                output_tokens: "32",
                cost_usd_micros: "4128",
                state: "settled",
                cost_unknown: false,
              },
            ]);
            expect(after.usage).toEqual([
              {
                input_tokens: "80",
                output_tokens: "20",
                cost_usd_micros: "100",
                reserved_input_tokens: "8192",
                reserved_output_tokens: "64",
                reserved_cost_usd_micros: "8256",
                unknown_attempts: "1",
              },
            ]);
            expectSpend(after.spend, "100", "8256", "1");
            const saved = await audits(f.db, f.runId);
            const attempts = saved.filter(
              (row) => row.kind === "model_attempt",
            );
            expect(
              attempts.map((row) => [row.payload.phase, row.payload.ordinal]),
            ).toEqual([
              ["start", 1],
              ["finish", 1],
              ["start", 2],
              ["finish", 2],
            ]);
            for (const row of attempts) {
              expect(row.visible).toBe(false);
              expect(row.context_excluded).toBe(true);
            }
            expect(attempts[0]!.payload).toMatchObject({
              providerConnectionId: "provider-1",
              modelProfileId: "model-1",
              model: "budget-model-a",
              reservation: { inputTokens: 8192, outputTokens: 64 },
            });
            expect(attempts[1]!.payload).toMatchObject({
              outcome: "failed",
              status: 429,
              usage: {},
            });
            expect(attempts[2]!.payload).toMatchObject({
              providerConnectionId: "provider-2",
              modelProfileId: "model-2",
              model: "budget-model-b",
              reservation: { inputTokens: 4096, outputTokens: 32 },
            });
            expect(attempts[3]!.payload).toMatchObject({
              outcome: "completed",
              usage: { inputTokens: 80, outputTokens: 20 },
            });
            const usage = saved.filter((row) => row.kind === "usage");
            expect(usage).toHaveLength(2);
            expect(usage[0]!.payload.measurement).toEqual({});
            expect(usage[1]!.payload.measurement).toMatchObject({
              inputTokens: 80,
              outputTokens: 20,
            });
            expect(f.preparations).toHaveBeenCalledTimes(2);
            for (const [request] of f.preparations.mock.calls)
              expect(request.snapshot.deadlineAt).toEqual(deadline);
            expect(
              (
                await f.db.observer.query<{ deadline: string }>(
                  "SELECT execution_snapshot->>'deadlineAt' AS deadline FROM runs WHERE id=$1",
                  [f.runId],
                )
              ).rows,
            ).toEqual([{ deadline: deadline.toISOString() }]);
          },
        );
      },
      duration,
    );
  },
);
