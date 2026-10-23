import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import { newResourceId } from "../../src/domain/resource-id.js";
import type { ConnectionBinding, RunState, SessionRecord } from "../../src/domain/types.js";
import type { ExecuteRunResult, SubmittedAcpRun } from "../../src/ports/acp-application.js";
import type {
  AcceptRunInput,
  CreateRunIntentInput,
  RunIntent,
  RunRepository,
} from "../../src/ports/run-repository.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { localExecution } from "../support/local-execution.js";

const SIZES = [1, 100, 1000] as const;
const BLOCK_ORDERS = [
  [1, 100, 1000],
  [1000, 1, 100],
  [100, 1000, 1],
] as const;
const WARMUPS = 50;
const SAMPLES_PER_BLOCK = 100;
const RUN_TIMEOUT_MS = 60_000;
const completed: ExecuteRunResult = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
};

type Size = (typeof SIZES)[number];
type StoredRun = {
  intent: RunIntent;
  state: RunState;
  transitions: Array<"intent" | "accepted" | "terminal">;
  acceptance: AcceptRunInput | null;
  cancellationRequested: boolean;
};

/** Phase 1 isolates database latency; these records are not durable PostgreSQL evidence. */
class MemoryRuns implements RunRepository {
  public readonly records = new Map<string, StoredRun>();
  public readonly ids = new Set<string>();
  private activeRunId: string | undefined;

  public constructor(public readonly session: SessionRecord) {}

  public getSession(sessionId: string): Promise<SessionRecord | null> {
    return Promise.resolve(sessionId === this.session.id ? structuredClone(this.session) : null);
  }

  public findBridgeIntent(): Promise<{ digest: string } | null> {
    return Promise.resolve(null);
  }

  public createRunIntent(input: CreateRunIntentInput): Promise<RunIntent> {
    if (input.sessionId !== this.session.id || input.bridgeIntent !== undefined)
      throw new Error("Unexpected benchmark Session or Bridge intent");
    if (this.activeRunId !== undefined)
      throw new Error("Memory repository already has a nonterminal Run");
    const ids = [input.runId, input.requestId, input.userMessageId];
    if (new Set(ids).size !== ids.length || ids.some((id) => this.ids.has(id)))
      throw new Error("Run admission reused a resource ID");
    for (const id of ids) this.ids.add(id);
    const intent: RunIntent = {
      id: input.runId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      clientMcpRevisionId: this.session.clientMcpRevisionId,
      expectedAccessRevision: input.expectedAccessRevision,
      state: "admitting",
      userMessageId: input.userMessageId,
      prompt: structuredClone(input.prompt),
      sessionConfiguration: {},
    };
    this.records.set(input.runId, {
      intent,
      state: "admitting",
      transitions: ["intent"],
      acceptance: null,
      cancellationRequested: false,
    });
    this.activeRunId = input.runId;
    return Promise.resolve(structuredClone(intent));
  }

  public requestCancellation(runId: string): Promise<void> {
    this.record(runId).cancellationRequested = true;
    return Promise.resolve();
  }

  public acceptRun(input: AcceptRunInput): Promise<"accepted" | "cancelled"> {
    const run = this.record(input.runId);
    if (run.state !== "admitting") throw new Error("Acceptance requires a stored intent");
    if (run.cancellationRequested) {
      run.state = "cancelled";
      run.transitions.push("terminal");
      this.activeRunId = undefined;
      return Promise.resolve("cancelled");
    }
    run.acceptance = structuredClone(input);
    run.state = "running";
    run.transitions.push("accepted");
    this.session.title = input.sessionTitle ?? this.session.title;
    this.session.lastExecutionRevision = input.snapshot.executionRevision;
    this.session.lastMessageSequence += 1;
    this.session.updatedAt = new Date(input.acceptedAt);
    return Promise.resolve("accepted");
  }

  public rejectRun(runId: string): Promise<"failed" | "cancelled"> {
    const run = this.record(runId);
    if (run.state !== "admitting") throw new Error("Rejection requires a stored intent");
    const state = run.cancellationRequested ? "cancelled" : "failed";
    run.state = state;
    run.transitions.push("terminal");
    this.activeRunId = undefined;
    return Promise.resolve(state);
  }

  public finish(runId: string): void {
    const run = this.record(runId);
    if (run.state !== "running" || run.acceptance === null)
      throw new Error("Completion requires an accepted Run");
    run.state = "completed";
    run.transitions.push("terminal");
    this.activeRunId = undefined;
    this.session.lastMessageSequence += 1;
  }

  public record(runId: string): StoredRun {
    const run = this.records.get(runId);
    if (run === undefined) throw new Error("Run has no stored intent");
    return run;
  }
}

async function fixture(size: Size) {
  const local = await localExecution(false);
  const configuration = executionConfiguration();
  const template = configuration.agents[0]!;
  configuration.agents = Array.from({ length: size }, (_unused, index) => {
    const number = (index + 1).toString().padStart(4, "0");
    const suffix = (index + 1).toString(16).padStart(32, "0");
    return {
      ...structuredClone(template),
      agent_id: `agent-${number}`,
      access_revision: `access-${number}`,
      agent_spec_revision: `agent-spec-${number}`,
      execution_revision: `execution-${number}`,
      system_prompt: `Synthetic admission Agent ${number}`,
      runtime: {
        runtime_revision: `rtv_${suffix}`,
        runtime_execution_id: `runtime-execution-${number}`,
        mcp_endpoint: `http://runtime-${number}:8080/mcp`,
        connection_id: `rci_${suffix}`,
        credential: {
          caller: "agent-acp-service" as const,
          token: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        },
      },
    };
  });
  const target = configuration.agents.at(-1)!;
  const runtime = target.runtime!;
  const connectionId = runtime.connection_id!;
  const binding: ConnectionBinding = {
    connectionId: `benchmark-${size}`,
    organizationId: configuration.organization_id,
    principalId: "principal-1",
    agentId: target.agent_id,
  };
  const now = new Date();
  const repository = new MemoryRuns({
    id: newResourceId("session"),
    organizationId: binding.organizationId,
    principalId: binding.principalId,
    agentId: binding.agentId,
    cwd: "/workspace",
    state: "active",
    title: null,
    forkedFromSessionId: null,
    clientMcpRevisionId: newResourceId("mcprev"),
    lastExecutionRevision: null,
    lastMessageSequence: 0,
    createdAt: now,
    updatedAt: now,
  });
  const failures: Error[] = [];
  const coordinator = new PromptCoordinator({
    directory: local.directory,
    repository,
    protection: { hasUnstoppedRuntimeCalls: () => Promise.resolve(false) },
    runTimeoutMs: RUN_TIMEOUT_MS,
    recoveryRequired: (error) => failures.push(error),
    id: newResourceId,
    now: () => new Date(),
  });
  const gates = new Set<PromiseWithResolvers<void>>();
  const submissions = new Set<Promise<unknown>>();
  const completions = new Set<Promise<ExecuteRunResult>>();
  let activeGate: PromiseWithResolvers<void> | undefined;
  // Execution is a finite stub; real admission and Runtime pinning remain in the timed path.
  const supervisor = new RunSupervisor({
    execute: async ({ accepted }) => {
      const gate = activeGate;
      if (gate === undefined) throw new Error("Executor has no owned completion gate");
      try {
        await gate.promise;
        repository.finish(accepted.runId);
        return completed;
      } finally {
        local.directory.releaseRuntimeRun(accepted.runId);
      }
    },
  });
  const input = {
    binding,
    sessionId: repository.session.id,
    prompt: [{ type: "text", text: "Fixed admission benchmark input" }],
  };
  const submissionInput = {
    binding,
    sessionId: input.sessionId,
    outputChanged: () => undefined,
  };
  const observe = (submission: Promise<SubmittedAcpRun>) => {
    submissions.add(submission);
    void submission.then(
      (accepted) => {
        completions.add(accepted.completion);
        void accepted.completion.catch(() => undefined);
      },
      () => undefined,
    );
  };
  const fence = {
    organizationId: binding.organizationId,
    agentId: binding.agentId,
    revision: runtime.runtime_revision,
    executionId: runtime.runtime_execution_id,
    mcpEndpoint: runtime.mcp_endpoint,
    connectionId,
  };
  const close = async () => {
    for (const gate of gates) gate.resolve();
    try {
      await Promise.allSettled([...submissions]);
      await Promise.allSettled([...completions]);
      await supervisor.shutdown();
    } finally {
      await local.connections.close();
      expect(existsSync(local.connections.directory)).toBe(false);
    }
  };
  try {
    await local.directory.apply(configuration);
    expect(configuration.agents.every((agent) => agent.accepting_runs)).toBe(true);
    expect(local.configurations.get(binding.organizationId)?.agents.at(-1)?.agent_id).toBe(
      target.agent_id,
    );
    expect(new Set(configuration.agents.map((agent) => agent.runtime!.connection_id)).size).toBe(
      size,
    );
    expect(readdirSync(local.connections.directory)).toHaveLength(size);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    async admit(checkBusyAndPins = false): Promise<number> {
      const gate = Promise.withResolvers<void>();
      gates.add(gate);
      activeGate = gate;
      let accepted: SubmittedAcpRun | undefined;
      const timed = (async () => {
        const started = performance.now();
        const submitted = await supervisor.submit(submissionInput, (signal) =>
          coordinator.accept(input, signal),
        );
        const elapsedMs = performance.now() - started;
        completions.add(submitted.completion);
        void submitted.completion.catch(() => undefined);
        return { submitted, elapsedMs };
      })();
      submissions.add(timed);
      void timed.catch(() => undefined);
      try {
        const measured = await timed;
        accepted = measured.submitted;
        const stored = repository.record(accepted.runId);
        expect(stored.state).toBe("running");
        expect(stored.transitions).toEqual(["intent", "accepted"]);
        expect(stored.intent).toMatchObject({
          id: accepted.runId,
          requestId: accepted.requestId,
          userMessageId: accepted.userMessageId,
          prompt: input.prompt,
          expectedAccessRevision: target.access_revision,
        });
        expect(stored.acceptance?.snapshot).toEqual(accepted.snapshot);
        expect(accepted.snapshot).toMatchObject({
          organizationId: binding.organizationId,
          configurationRevision: configuration.revision,
          accessRevision: target.access_revision,
          agentSpecRevision: target.agent_spec_revision,
          executionRevision: target.execution_revision,
          providerConnectionId: configuration.providers[0]!.connection_id,
          modelProfileId: target.default_model_profile_id,
          clientMcpRevisionId: repository.session.clientMcpRevisionId,
          runtime: {
            revision: runtime.runtime_revision,
            executionId: runtime.runtime_execution_id,
            mcpEndpoint: runtime.mcp_endpoint,
            connectionId,
          },
          executionSpec: { systemPrompt: target.system_prompt },
        });
        expect(accepted.snapshot.runtimeMcpSourceDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(accepted.snapshot.agentExecutionSpecDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(accepted.outputSequence).toBe(repository.session.lastMessageSequence - 1);
        expect(supervisor.occupancy(binding)).toEqual({
          busy: true,
          activeSessionId: input.sessionId,
        });
        if (checkBusyAndPins) {
          const intents = repository.records.size;
          const ids = repository.ids.size;
          const duplicate = supervisor.submit(submissionInput, (signal) =>
            coordinator.accept(input, signal),
          );
          observe(duplicate);
          await expect(duplicate).rejects.toMatchObject({ code: "agent_busy" });
          expect(repository.records.size).toBe(intents);
          expect(repository.ids.size).toBe(ids);
          expect(stored.transitions).toEqual(["intent", "accepted"]);
          local.connections.revokePublication(binding.organizationId);
          expect(local.connections.findForCleanup(fence)).toEqual(accepted.snapshot.runtime);
          expect(existsSync(join(local.connections.directory, connectionId))).toBe(true);
          expect(readdirSync(local.connections.directory)).toEqual([connectionId]);
        }
        return measured.elapsedMs;
      } finally {
        gate.resolve();
        gates.delete(gate);
        if (accepted !== undefined) {
          expect(await accepted.completion).toEqual(completed);
          expect(repository.record(accepted.runId).transitions).toEqual([
            "intent",
            "accepted",
            "terminal",
          ]);
          expect(repository.record(accepted.runId).state).toBe("completed");
        }
        activeGate = undefined;
        expect(supervisor.occupancy(binding)).toEqual({ busy: false, activeSessionId: null });
        if (checkBusyAndPins) {
          expect(local.connections.findForCleanup(fence)).toBeNull();
          expect(readdirSync(local.connections.directory)).toEqual([]);
        }
      }
    },
    assertFinished() {
      const count = WARMUPS + BLOCK_ORDERS.length * SAMPLES_PER_BLOCK + 1;
      expect(repository.records.size).toBe(count);
      expect(repository.ids.size).toBe(count * 3);
      for (const run of repository.records.values()) {
        expect(run.state).toBe("completed");
        expect(run.transitions).toEqual(["intent", "accepted", "terminal"]);
        expect(run.acceptance).not.toBeNull();
      }
      expect(failures).toEqual([]);
      expect(gates.size).toBe(0);
      expect(supervisor.occupancy(binding).busy).toBe(false);
      return { intents: count, accepted: count, terminal: count, uniqueIds: repository.ids.size };
    },
    close,
  };
}

function summary(samplesMs: readonly number[]) {
  const sorted = samplesMs.toSorted((left, right) => left - right);
  const middle = sorted.length / 2;
  const medianMs = Number.isInteger(middle)
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[Math.floor(middle)]!;
  return {
    count: sorted.length,
    totalMs: samplesMs.reduce((total, sample) => total + sample, 0),
    medianMs,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

describe("Phase 1 application admission scaling", () => {
  it("measures equal real admission work across 1, 100 and 1000 configured Agents", async () => {
    const fixtures = new Map<Size, Awaited<ReturnType<typeof fixture>>>();
    const blocks: Array<{
      block: number;
      order: readonly Size[];
      results: Array<{ agents: Size; samplesMs: number[] } & ReturnType<typeof summary>>;
    }> = [];
    const business: Array<{
      agents: Size;
      intents: number;
      accepted: number;
      terminal: number;
      uniqueIds: number;
    }> = [];
    const failures: unknown[] = [];
    let businessPassed = false;
    let cleanupPassed = true;
    try {
      for (const size of SIZES) fixtures.set(size, await fixture(size));
      for (const size of SIZES)
        for (let sample = 0; sample < WARMUPS; sample++) await fixtures.get(size)!.admit();
      for (const [index, order] of BLOCK_ORDERS.entries()) {
        const block = {
          block: index + 1,
          order,
          results: [] as (typeof blocks)[number]["results"],
        };
        blocks.push(block);
        for (const size of order) {
          const samplesMs: number[] = [];
          for (let sample = 0; sample < SAMPLES_PER_BLOCK; sample++)
            samplesMs.push(await fixtures.get(size)!.admit());
          block.results.push({ agents: size, samplesMs, ...summary(samplesMs) });
        }
      }
      for (const size of SIZES) {
        const current = fixtures.get(size)!;
        await current.admit(true);
        business.push({ agents: size, ...current.assertFinished() });
      }
      businessPassed = true;
    } catch (error) {
      failures.push(error);
    } finally {
      for (const current of [...fixtures.values()].toReversed()) {
        try {
          await current.close();
        } catch (error) {
          cleanupPassed = false;
          failures.push(error);
        }
      }
    }
    process.stdout.write(
      JSON.stringify({
        benchmark: "agent-acp-phase1-application-admission",
        boundary:
          "real submit/coordinator/directory/snapshot/Runtime pin; memory repository and finite executor; no database/model/network timing",
        clock: "performance.now, immediately before submit until accepted result",
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        warmupsPerSize: WARMUPS,
        samplesPerBlock: SAMPLES_PER_BLOCK,
        blocks,
        aggregate: SIZES.map((size) => {
          const samplesMs = blocks.flatMap((block) =>
            block.results
              .filter((result) => result.agents === size)
              .flatMap((result) => result.samplesMs),
          );
          return { agents: size, ...(samplesMs.length === 0 ? {} : summary(samplesMs)) };
        }),
        business,
        businessPassed,
        cleanupPassed,
      }) + "\n",
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Admission benchmark or cleanup failed");
  }, 60_000);
});
