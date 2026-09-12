import { describe, expect, it, vi } from "vitest";
import { SessionConfigurationService } from "../../src/application/session-configuration.js";
import { AcpApplication } from "../../src/application/application.js";
import type { AcpApplicationDependencies } from "../../src/application/application.js";
import { DomainError } from "../../src/domain/errors.js";
import type { SessionConfigurationRepository } from "../../src/ports/session-configuration.js";
import { binding, configurationCatalog } from "../support/fixtures.js";

function fixture() {
  const get = vi.fn<SessionConfigurationRepository["get"]>(() =>
    Promise.resolve({ configuration: {}, revision: 3 }),
  );
  const save = vi.fn<SessionConfigurationRepository["save"]>(() => Promise.resolve());
  const requireAuthorized = vi.fn();
  const catalog = vi.fn(() => Promise.resolve(configurationCatalog()));
  const service = new SessionConfigurationService({
    sessions: { requireAuthorized },
    repository: { get, save },
    controller: { getSessionConfiguration: catalog },
    id: () => "request-id",
    now: () => new Date(0),
  });
  return {
    get,
    save,
    requireAuthorized,
    catalog,
    service,
    input: { binding: binding(), sessionId: "session-1" },
  };
}

describe("Session configuration application", () => {
  it("reads every model page through the current Agent/owner contract", async () => {
    const f = fixture();
    f.catalog.mockResolvedValueOnce({ ...configurationCatalog(), nextCursor: "profile-1" });
    const second = configurationCatalog();
    second.models[0]!.modelProfileId = "profile-2";
    f.catalog.mockResolvedValueOnce(second);
    const view = await f.service.get(f.input);
    expect(view.models.map((m) => m.id)).toEqual([
      "agent_default",
      "profile:profile-1",
      "profile:profile-2",
    ]);
    expect(f.catalog).toHaveBeenLastCalledWith({
      requestId: "request-id",
      agentId: "agent-1",
      principalId: "principal-1",
      expectedAccessRevision: "access-1",
      limit: 200,
      afterId: "profile-1",
    });
  });
  it("rejects a repeated cursor instead of looping forever", async () => {
    const f = fixture();
    f.catalog.mockResolvedValue({ ...configurationCatalog(), nextCursor: "same" });
    await expect(f.service.get(f.input)).rejects.toMatchObject({ code: "invalid_model_catalog" });
    expect(f.catalog).toHaveBeenCalledTimes(2);
  });
  it("checks Session ownership before exposing the model directory", async () => {
    const f = fixture();
    f.requireAuthorized.mockRejectedValue(new DomainError("session_access_denied", "Denied"));
    await expect(
      f.service.set({ ...f.input, configId: "mode", value: "chat" }),
    ).rejects.toMatchObject({ code: "session_access_denied" });
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
  it("persists only overrides with a revision and the full notification view", async () => {
    const f = fixture();
    const view = await f.service.set({ ...f.input, configId: "mode", value: "chat" });
    expect(f.save).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRevision: 3,
      configuration: { authorizationMode: "chat" },
      view,
      changedAt: new Date(0),
    });
    expect(view.modeId).toBe("chat");
    expect(view.models).toHaveLength(2);
  });
  it("does not save invalid values or silently retry stale revisions", async () => {
    const f = fixture();
    await expect(
      f.service.set({ ...f.input, configId: "model", value: "foreign" }),
    ).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled();
    f.save.mockRejectedValue(new DomainError("configuration_conflict", "Changed"));
    await expect(
      f.service.set({ ...f.input, configId: "mode", value: "chat" }),
    ).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(f.save).toHaveBeenCalledOnce();
  });
  it.each(["getSessionConfiguration", "setSessionConfiguration"] as const)(
    "%s checks live access before configuration work",
    async (method) => {
      const configuration = { get: vi.fn(), set: vi.fn() };
      const app = new AcpApplication({
        access: { assert: () => Promise.reject(new Error("revoked")) },
        configuration,
      } as unknown as AcpApplicationDependencies);
      await expect(
        app[method]({
          binding: binding(),
          sessionId: "session-1",
          configId: "mode",
          value: "auto",
        }),
      ).rejects.toThrow("revoked");
      expect(configuration.get).not.toHaveBeenCalled();
      expect(configuration.set).not.toHaveBeenCalled();
    },
  );
});
