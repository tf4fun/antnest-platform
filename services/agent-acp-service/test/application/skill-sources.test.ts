import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { learningSkillTextPackage } from "../../src/domain/learning-candidate-package.js";
import { SkillSources } from "../../src/application/skill-sources.js";
import { LearningForegroundGate } from "../../src/application/learning-foreground-gate.js";
import { RuntimeSkillCommands } from "../../src/application/runtime-skill-commands.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";

const organization_id = `org_${"a".repeat(32)}`;
const agent_id = `agent_${"b".repeat(32)}`;
const owner_id = `user_${"c".repeat(32)}`;
const text =
  '---\nname: "inspect-first"\ndescription: "Inspect before editing."\n---\nInspect the file.\n';
const key = { agent_id, name: "inspect-first" };
const runtime = {
  runtime_revision: `rtv_${"a".repeat(32)}`,
  runtime_execution_id: "execution-1",
  mcp_endpoint: "http://runtime:8080/mcp",
  connection_id: `rci_${"b".repeat(32)}`,
};

function setup() {
  const packageValue = learningSkillTextPackage(text);
  const projection = {
    organization_id,
    agent_id,
    owner_id,
    name: key.name,
    description: "Inspect before editing.",
    sequence: 1,
    content_digest: packageValue.targetDigest,
    active: true,
  };
  const record = {
    projection,
    packagePath: `.antnest/skills/${key.name}`,
    candidateId: "candidate-1",
    taskId: "task-1",
    generation: 1,
    effectRequestId: "commit-1",
    package: packageValue,
  };
  const inspect = vi.fn(() => ({ agent: { accepting_runs: true, runtime } }));
  const read = vi.fn(() => Promise.resolve(record));
  const remove = vi.fn(() => Promise.resolve());
  const verify = vi.fn(() => Promise.resolve("current" as "current" | "changed" | "unknown"));
  const finish = vi.fn();
  const begin = vi.fn((_scope: unknown, signal: AbortSignal) =>
    Promise.resolve({ signal, finish }),
  );
  const service = new SkillSources({
    directory: { inspect },
    repository: { read, remove },
    runtime: { verify },
    gate: { beginSourceRead: begin },
  });
  const input = { organization_id, actor_id: owner_id, sources: [key] };
  const artifact = {
    organization_id,
    actor_id: owner_id,
    skill_ref: { kind: "agent" as const, ...key, sequence: 1 },
    expected_digest: packageValue.targetDigest,
  };
  return {
    service,
    record,
    projection,
    input,
    artifact,
    inspect,
    read,
    remove,
    verify,
    begin,
    finish,
  };
}

function sourceAuthority() {
  const cancellation = new AbortController();
  const failure = new Error("Original source authority is no longer current");
  let current = true;
  return {
    authority: {
      fence: Object.freeze({
        organizationId: organization_id,
        agentId: agent_id,
        ownerInstanceId: "11111111-1111-4111-8111-111111111111",
        epoch: "7",
      }),
      signal: cancellation.signal,
      assertCurrent: vi.fn(() => {
        cancellation.signal.throwIfAborted();
        if (!current) throw failure;
      }),
    },
    invalidate() {
      current = false;
    },
    cancel() {
      cancellation.abort(failure);
    },
  };
}

describe("current Agent-owned Skill sources", () => {
  it("passes the originally admitted owner fence to inspect and artifact source gates", async () => {
    const s = setup();
    const admitted = sourceAuthority();
    const caller = new AbortController();
    expect(await s.service.inspect(s.input, caller.signal, admitted.authority)).toEqual({
      items: [s.projection],
    });
    expect(await s.service.artifact(s.artifact, caller.signal, admitted.authority)).toEqual(
      s.record,
    );
    expect(s.begin).toHaveBeenCalledTimes(2);
    for (const [scope] of s.begin.mock.calls)
      expect(scope).toEqual({
        organizationId: organization_id,
        agentId: agent_id,
        ownerFence: admitted.authority.fence,
      });
    expect(admitted.authority.assertCurrent).toHaveBeenCalled();
    expect(s.verify).toHaveBeenCalledTimes(2);
    expect(s.finish).toHaveBeenCalledTimes(2);
  });

  it("does not observe Runtime when admitted authority changes during the initial repository read", async () => {
    const s = setup();
    const admitted = sourceAuthority();
    const entered = Promise.withResolvers<void>();
    const original = Promise.withResolvers<typeof s.record>();
    s.read.mockImplementationOnce(() => {
      entered.resolve();
      return original.promise;
    });
    const pending = s.service
      .artifact(s.artifact, new AbortController().signal, admitted.authority)
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    try {
      await entered.promise;
      admitted.invalidate();
      expect(admitted.authority.signal.aborted).toBe(false);
      original.resolve(s.record);
      const result = await pending;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "source_unavailable" });
      expect(s.verify).not.toHaveBeenCalled();
      expect(s.remove).not.toHaveBeenCalled();
      expect(s.finish).toHaveBeenCalledTimes(s.begin.mock.calls.length);
    } finally {
      original.resolve(s.record);
      await Promise.allSettled([pending]);
    }
  });

  it("joins the original Runtime observation before finishing the gate after authority cancellation", async () => {
    const s = setup();
    const admitted = sourceAuthority();
    const caller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const original = Promise.withResolvers<"current">();
    let originalJoined = false,
      settled = false;
    s.verify.mockImplementationOnce(() => {
      entered.resolve();
      return original.promise.finally(() => {
        originalJoined = true;
      });
    });
    s.finish.mockImplementation(() => {
      expect(originalJoined, "the original Runtime task must settle before gate.finish").toBe(true);
    });
    const pending = s.service
      .artifact(s.artifact, caller.signal, admitted.authority)
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      admitted.cancel();
      expect(caller.signal.aborted).toBe(false);
      expect(admitted.authority.signal.aborted).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled, "authority cancellation is not the original Runtime cleanup receipt").toBe(
        false,
      );
      expect(originalJoined).toBe(false);
      expect(s.finish).not.toHaveBeenCalled();
      original.resolve("current");
      const result = await pending;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "source_unavailable" });
      expect(originalJoined).toBe(true);
      expect(s.verify).toHaveBeenCalledTimes(1);
      expect(s.finish).toHaveBeenCalledTimes(1);
      expect(s.remove).not.toHaveBeenCalled();
    } finally {
      original.resolve("current");
      await Promise.allSettled([pending]);
    }
  });

  it("waits for a catalog read before verifying and delivering the selected source once", async () => {
    const s = setup();
    const gate = new LearningForegroundGate(() => false);
    const catalogResult = Promise.withResolvers<ReturnType<typeof runtimeInformation>>();
    const readBinding = vi.fn(() => catalogResult.promise);
    const commands = new RuntimeSkillCommands({
      directory: { inspect: s.inspect },
      busy: () => false,
      runtime: { readBinding },
      gate,
    });
    const signal = new AbortController().signal;
    const catalog = commands.read(
      {
        organizationId: organization_id,
        agentId: agent_id,
        principalId: owner_id,
        connectionId: "browser-1",
      },
      signal,
    );
    expect(readBinding).toHaveBeenCalledTimes(1);
    const source = new SkillSources({
      directory: { inspect: s.inspect },
      repository: { read: s.read, remove: s.remove },
      runtime: { verify: s.verify },
      gate,
    });
    const result = source.artifact(s.artifact, signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(s.verify).not.toHaveBeenCalled();
    catalogResult.resolve(runtimeInformation());
    await catalog;
    expect(await result).toEqual({ value: s.record });
    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("serializes simultaneous inspect and artifact reads without overlapping Runtime observations", async () => {
    const s = setup();
    const gate = new LearningForegroundGate(() => false);
    const observed = Promise.withResolvers<"current">();
    const entered = Promise.withResolvers<void>();
    s.verify.mockImplementationOnce(() => {
      entered.resolve();
      return observed.promise;
    });
    const source = new SkillSources({
      directory: { inspect: s.inspect },
      repository: { read: s.read, remove: s.remove },
      runtime: { verify: s.verify },
      gate,
    });
    const signal = new AbortController().signal;
    const inspect = source.inspect(s.input, signal);
    await entered.promise;
    const artifact = source.artifact(s.artifact, signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(s.verify).toHaveBeenCalledTimes(1);
    observed.resolve("current");
    expect(await inspect).toEqual({ items: [s.projection] });
    expect(await artifact).toEqual({ value: s.record });
    expect(s.verify).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["owner", "not_found"],
    ["access", "not_found"],
    ["inactive", "not_found"],
    ["sequence", "content_changed"],
    ["digest", "content_changed"],
    ["runtime_revision", "source_unavailable"],
    ["runtime_execution_id", "source_unavailable"],
    ["connection_id", "source_unavailable"],
    ["mcp_endpoint", "source_unavailable"],
  ] as const)(
    "rechecks %s after waiting and never dispatches a stale observation",
    async (change, code) => {
      const s = setup();
      const gate = new LearningForegroundGate(() => false);
      const signal = new AbortController().signal;
      const catalog = gate.begin({ organizationId: organization_id, agentId: agent_id }, signal);
      const source = new SkillSources({
        directory: { inspect: s.inspect },
        repository: { read: s.read, remove: s.remove },
        runtime: { verify: s.verify },
        gate,
      });
      const rejected = expect(source.artifact(s.artifact, signal)).rejects.toMatchObject({ code });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (change === "owner")
          s.read.mockResolvedValue({
            ...s.record,
            projection: { ...s.projection, owner_id: "another-owner" },
          });
        else if (change === "inactive")
          s.read.mockResolvedValue({ ...s.record, projection: { ...s.projection, active: false } });
        else if (change === "sequence")
          s.read.mockResolvedValue({ ...s.record, projection: { ...s.projection, sequence: 2 } });
        else if (change === "digest")
          s.read.mockResolvedValue({
            ...s.record,
            projection: { ...s.projection, content_digest: `sha256:${"f".repeat(64)}` },
          });
        else if (change === "access")
          s.inspect.mockImplementation(() => {
            throw new DomainError("access_denied", "revoked");
          });
        else
          s.inspect.mockReturnValue({
            agent: { accepting_runs: true, runtime: { ...runtime, [change]: "changed" } },
          });
        catalog.finish();
        await rejected;
        expect(s.verify).not.toHaveBeenCalled();
        expect(s.remove).not.toHaveBeenCalled();
        gate.begin({ organizationId: organization_id, agentId: agent_id }, signal).finish();
      } finally {
        catalog.finish();
      }
    },
  );

  it.each(["before", "after"] as const)(
    "discards a source preempted during the database check %s observation",
    async (phase) => {
      const s = setup();
      const gate = new LearningForegroundGate(() => false);
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<typeof s.record>();
      s.read.mockResolvedValueOnce(s.record);
      if (phase === "after") s.read.mockResolvedValueOnce(s.record);
      s.read.mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      });
      const source = new SkillSources({
        directory: { inspect: s.inspect },
        repository: { read: s.read, remove: s.remove },
        runtime: { verify: s.verify },
        gate,
      });
      const signal = new AbortController().signal;
      const rejected = expect(source.artifact(s.artifact, signal)).rejects.toMatchObject({
        code: "source_unavailable",
      });
      await entered.promise;
      const foreground = gate.preempt(
        { organizationId: organization_id, agentId: agent_id },
        signal,
      );
      pending.resolve(s.record);
      await rejected;
      await foreground;
      expect(s.verify).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      gate.begin({ organizationId: organization_id, agentId: agent_id }, signal).finish();
    },
  );

  it("finishes an in-flight bounded read before admitting foreground and discards preempted delivery", async () => {
    const s = setup();
    const gate = new LearningForegroundGate(() => false);
    gate.syncOrganization(organization_id, [{ agent_id, accepting_runs: true }]);
    const observed = Promise.withResolvers<"current">();
    const entered = Promise.withResolvers<void>();
    const source = new SkillSources({
      directory: { inspect: s.inspect },
      repository: { read: s.read, remove: s.remove },
      runtime: {
        verify: () => {
          entered.resolve();
          return observed.promise;
        },
      },
      gate,
    });
    const read = source.artifact(s.artifact, new AbortController().signal);
    const rejected = expect(read).rejects.toMatchObject({ code: "source_unavailable" });
    await entered.promise;
    let admitted = false;
    const preempted = gate
      .preempt({ organizationId: organization_id, agentId: agent_id }, new AbortController().signal)
      .then(() => {
        admitted = true;
      });
    await Promise.resolve();
    expect(admitted).toBe(false);
    observed.resolve("current");
    await rejected;
    await preempted;
    expect(admitted).toBe(true);
    gate
      .begin({ organizationId: organization_id, agentId: agent_id }, new AbortController().signal)
      .finish();
  });
  it("checks current full-package observation and returns metadata/exact selected bytes without a Run", async () => {
    const s = setup();
    const signal = new AbortController().signal;
    expect(await s.service.inspect(s.input, signal)).toEqual({ items: [s.projection] });
    const loaded = await s.service.artifact(s.artifact, signal);
    expect(loaded.package.artifact).toEqual(s.record.package.artifact);
    expect(loaded.projection).toEqual(s.projection);
    expect(s.verify).toHaveBeenCalledTimes(2);
    expect(s.verify).toHaveBeenCalledWith(
      s.record,
      {
        revision: runtime.runtime_revision,
        executionId: runtime.runtime_execution_id,
        mcpEndpoint: runtime.mcp_endpoint,
        connectionId: runtime.connection_id,
      },
      signal,
    );
    expect(s.finish).toHaveBeenCalledWith();
  });

  it.each(["runtime_revision", "connection_id"] as const)(
    "rejects a changed %s even when the endpoint and execution fence are unchanged",
    async (field) => {
      const s = setup();
      s.verify.mockImplementation(() => {
        s.inspect.mockReturnValue({
          agent: {
            accepting_runs: true,
            runtime: {
              ...runtime,
              [field]: `${field === "connection_id" ? "rci" : "rtv"}_${"f".repeat(32)}`,
            },
          },
        });
        return Promise.resolve("current");
      });
      await expect(
        s.service.artifact(s.artifact, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "source_unavailable",
      });
    },
  );

  it("does not reveal another owner's personal source even if Agent access allows that actor", async () => {
    const s = setup();
    const other = `user_${"d".repeat(32)}`;
    expect(
      await s.service.inspect({ ...s.input, actor_id: other }, new AbortController().signal),
    ).toEqual({ items: [] });
    await expect(
      s.service.artifact({ ...s.artifact, actor_id: other }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(s.verify).not.toHaveBeenCalled();
  });

  it("omits denied/missing sources, but returns unavailable rather than a false empty success during startup", async () => {
    const s = setup();
    s.inspect.mockImplementation(() => {
      throw new DomainError("access_denied", "denied");
    });
    expect(await s.service.inspect(s.input, new AbortController().signal)).toEqual({ items: [] });
    s.inspect.mockImplementation(() => {
      throw new DomainError("configuration_not_ready", "not ready");
    });
    await expect(s.service.inspect(s.input, new AbortController().signal)).rejects.toMatchObject({
      code: "source_unavailable",
    });
  });

  it("rejects old refs and digest drift instead of substituting a retained candidate", async () => {
    const s = setup();
    await expect(
      s.service.artifact(
        { ...s.artifact, skill_ref: { ...s.artifact.skill_ref, sequence: 2 } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "content_changed" });
    s.verify.mockResolvedValue("changed");
    await expect(
      s.service.artifact(s.artifact, new AbortController().signal),
    ).rejects.toMatchObject({ code: "content_changed" });
    expect(s.remove).toHaveBeenCalledWith(s.projection);
    expect(await s.service.inspect(s.input, new AbortController().signal)).toEqual({ items: [] });
  });

  it("keeps unknown/offline/busy sources unavailable and never calls a model or preempts foreground work", async () => {
    const s = setup();
    s.verify.mockResolvedValue("unknown");
    await expect(
      s.service.artifact(s.artifact, new AbortController().signal),
    ).rejects.toMatchObject({ code: "source_unavailable" });
    expect(s.remove).not.toHaveBeenCalled();
    s.begin.mockImplementation(() => {
      throw new Error("busy");
    });
    await expect(s.service.inspect(s.input, new AbortController().signal)).rejects.toMatchObject({
      code: "source_unavailable",
    });
    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it("rechecks authorization, binding and source sequence after observation", async () => {
    const s = setup();
    s.verify.mockImplementation(() => {
      s.read.mockResolvedValue({ ...s.record, projection: { ...s.projection, sequence: 2 } });
      return Promise.resolve("current");
    });
    await expect(
      s.service.artifact(s.artifact, new AbortController().signal),
    ).rejects.toMatchObject({ code: "content_changed" });
    s.read.mockResolvedValue(s.record);
    s.verify.mockImplementation(() => {
      s.inspect.mockImplementation(() => {
        throw new DomainError("access_denied", "revoked");
      });
      return Promise.resolve("current");
    });
    await expect(
      s.service.artifact(s.artifact, new AbortController().signal),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
