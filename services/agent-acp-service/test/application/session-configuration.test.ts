import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { SessionConfigurationService } from "../../src/application/session-configuration.js";
import { DomainError } from "../../src/domain/errors.js";
import type { SessionConfigurationRepository } from "../../src/ports/session-configuration.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { localExecution } from "../support/local-execution.js";
import { binding, sessionRecord } from "../support/fixtures.js";

async function fixture() {
  const local = await localExecution();
  const get = vi.fn<SessionConfigurationRepository["get"]>(() =>
    Promise.resolve({ configuration: {}, revision: 3 }),
  );
  const save = vi.fn<SessionConfigurationRepository["save"]>(() => Promise.resolve());
  const requireAuthorized = vi.fn(() => Promise.resolve(sessionRecord()));
  const service = new SessionConfigurationService({
    sessions: { requireAuthorized },
    repository: { get, save },
    directory: local.directory,
    now: () => new Date(0),
  });
  return {
    ...local,
    get,
    save,
    requireAuthorized,
    service,
    input: { binding: binding(), sessionId: "session-1" },
  };
}

describe("local Session configuration", () => {
  it("reads the complete current organization catalog without pagination or Controller calls", async () => {
    const f = await fixture();
    const next = executionConfiguration();
    next.revision = 2;
    next.models.push({ ...next.models[0]!, model_profile_id: "model-2", display_name: "Second" });
    await f.directory.apply(next);
    expect((await f.service.get(f.input)).models.map((model) => model.id)).toEqual([
      "agent_default",
      "profile:model-1",
      "profile:model-2",
    ]);
  });

  it("keeps unavailable selections visible without allowing their selection", async () => {
    const f = await fixture();
    const next = executionConfiguration();
    next.revision = 2;
    next.models[0]!.enabled = false;
    await f.directory.apply(next);
    f.get.mockResolvedValue({ configuration: { modelProfileId: "model-1" }, revision: 3 });
    const view = await f.service.get(f.input);
    expect(view.models).toEqual([
      { id: "agent_default", name: "Agent default: Test model (Unavailable)" },
      { id: "profile:model-1", name: "Unavailable selected model" },
    ]);
    await expect(
      f.service.set({ ...f.input, configId: "model", value: "profile:model-1" }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
    expect(f.save).not.toHaveBeenCalled();
  });

  it("checks Session ownership before reading or persisting configuration", async () => {
    const f = await fixture();
    f.requireAuthorized.mockRejectedValue(new DomainError("session_access_denied", "Denied"));
    await expect(
      f.service.set({ ...f.input, configId: "mode", value: "chat" }),
    ).rejects.toMatchObject({ code: "session_access_denied" });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it("persists only Session overrides and permits overriding the Agent default", async () => {
    const f = await fixture();
    const view = await f.service.set({ ...f.input, configId: "mode", value: "auto" });
    expect(view.modeId).toBe("auto");
    expect(f.save).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRevision: 3,
      configuration: { authorizationMode: "auto" },
      view,
      changedAt: new Date(0),
    });
    expect(
      await f.directory.withAccess(binding(), ({ agent }) =>
        Promise.resolve(agent.default_authorization.mode),
      ),
    ).toBe("approve");
  });

  it("rejects a stale Bridge configuration revision before writing", async () => {
    const f = await fixture();
    const expectedRevision = createHash("sha256")
      .update(JSON.stringify(["session-1", "3"]))
      .digest("hex");
    await expect(
      f.service.set({ ...f.input, configId: "mode", value: "chat", expectedRevision }),
    ).resolves.toMatchObject({ modeId: "chat" });
    expect(f.save).toHaveBeenCalledOnce();
    f.save.mockClear();
    await expect(
      f.service.set({
        ...f.input,
        configId: "mode",
        value: "auto",
        expectedRevision: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "configuration_conflict",
    });
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([
    { configId: "model", value: "profile:foreign" },
    { configId: "mode", value: "invalid-mode" },
    { configId: "mode", value: true },
    { configId: "unknown", value: "auto" },
  ])("rejects invalid configuration %j without a write", async (change) => {
    const f = await fixture();
    await expect(f.service.set({ ...f.input, ...change })).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled();
  });

  it("does not hide a concurrent Session configuration conflict", async () => {
    const f = await fixture();
    f.save.mockRejectedValue(new DomainError("configuration_conflict", "Changed"));
    await expect(
      f.service.set({ ...f.input, configId: "mode", value: "chat" }),
    ).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(f.save).toHaveBeenCalledOnce();
  });

  it("serializes a pending configuration commit before revocation and rejects later writes", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    f.save.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      order.push("saved");
    });
    const changing = f.service.set({ ...f.input, configId: "mode", value: "auto" });
    await Promise.race([entered.promise, changing]);
    const next = executionConfiguration();
    next.revision = 2;
    next.agents[0]!.principal_ids = [];
    const revoking = f.directory.apply(next).then(() => {
      order.push("revoked");
    });
    const denied = expect(
      f.service.set({ ...f.input, configId: "mode", value: "chat" }),
    ).rejects.toMatchObject({ code: "access_denied" });
    release.resolve();
    await changing;
    await revoking;
    await denied;
    expect(order).toEqual(["saved", "revoked"]);
    expect(f.save).toHaveBeenCalledOnce();
  });
});
