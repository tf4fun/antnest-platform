import { expect, it, vi } from "vitest";
import { RuntimeSkillCommands } from "../../src/application/runtime-skill-commands.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";
import { LearningForegroundGate } from "../../src/application/learning-foreground-gate.js";

it("keeps catalog reads out of a learning/source slot and yields the read before foreground admission", async () => {
  const gate = new LearningForegroundGate(() => false);
  const scope = { organizationId: "org-1", agentId: "agent-1" };
  const signal = new AbortController().signal;
  const active = gate.begin(scope, signal);
  const binding = { ...scope, connectionId: "connection-1", principalId: "principal-1" };
  const readBinding = vi.fn(() => Promise.resolve(runtimeInformation()));
  const commands = new RuntimeSkillCommands({
    directory: {
      inspect: () => ({
        agent: {
          accepting_runs: true,
          runtime: {
            runtime_execution_id: "runtime-execution-1",
            runtime_revision: "runtime-revision-1",
            mcp_endpoint: "http://runtime/mcp",
          },
        },
      }),
    },
    busy: () => false,
    runtime: { readBinding },
    gate,
  });
  expect(await commands.read(binding, signal)).toEqual({
    executionId: "runtime-execution-1",
    commands: null,
  });
  expect(readBinding).not.toHaveBeenCalled();
  active.finish(true);
  const entered = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<ReturnType<typeof runtimeInformation>>();
  readBinding.mockImplementation(() => {
    entered.resolve();
    return finished.promise;
  });
  const pending = commands.read(binding, signal);
  await entered.promise;
  let admitted = false;
  const preempt = gate.preempt(scope, signal).then(() => {
    admitted = true;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  finished.resolve(runtimeInformation());
  expect(await pending).toEqual({ executionId: "runtime-execution-1", commands: null });
  await preempt;
  expect(admitted).toBe(true);
});

it("discovers authorized current Runtime metadata without reading Skill bodies or disturbing an active Run", async () => {
  const runtime = {
    runtime_execution_id: "runtime-execution-1",
    mcp_endpoint: "http://runtime/mcp",
    runtime_revision: "runtime-1",
  };
  const inspect = vi.fn(() => ({ agent: { accepting_runs: true, runtime } }));
  let busy = false;
  const readBinding = vi.fn(() => Promise.resolve(runtimeInformation()));
  const commands = new RuntimeSkillCommands({
    directory: { inspect },
    busy: () => busy,
    runtime: { readBinding },
  });
  const binding = {
    connectionId: "connection-1",
    organizationId: "org-1",
    agentId: "agent-1",
    principalId: "principal-1",
  };
  const signal = new AbortController().signal;
  expect(await commands.read(binding, signal)).toMatchObject({
    executionId: "runtime-execution-1",
    commands: [{ name: "skill:system:documents" }],
  });
  busy = true;
  expect(await commands.read(binding, signal)).toEqual({
    executionId: "runtime-execution-1",
    commands: null,
  });
  expect(readBinding).toHaveBeenCalledTimes(1);
  busy = false;
  inspect
    .mockImplementationOnce(() => ({ agent: { accepting_runs: true, runtime } }))
    .mockImplementationOnce(() => ({
      agent: {
        accepting_runs: true,
        runtime: { ...runtime, runtime_execution_id: "new-execution" },
      },
    }));
  expect(await commands.read(binding, signal)).toEqual({ executionId: null, commands: [] });
  inspect.mockImplementation(() => {
    throw new Error("access denied");
  });
  await expect(commands.read(binding, signal)).rejects.toThrow("access denied");
  expect(readBinding).toHaveBeenCalledTimes(2);
});
