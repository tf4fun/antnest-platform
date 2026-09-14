import { describe, expect, it, vi } from "vitest";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { parseExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import type {
  AuthenticatedModelTransport,
  ModelRequest,
  ModelResult,
} from "../../src/ports/model.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { snapshot } from "../support/fixtures.js";

function request(): ModelRequest {
  return { snapshot: snapshot(), messages: [], tools: [], signal: new AbortController().signal };
}

function result(): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: "ok" }],
    usage: {},
    stopReason: "end_turn",
  };
}

function setup() {
  const calls = vi.fn<AuthenticatedModelTransport["complete"]>(() => Promise.resolve(result()));
  const clients = new ProviderClients({ complete: calls });
  clients.apply(parseExecutionConfiguration(executionConfiguration()));
  return { clients, calls };
}

describe("logical Provider clients", () => {
  it("keeps authentication inside the client rather than the caller", async () => {
    const { clients, calls } = setup();
    const handle = clients.acquire("organization-1", "provider-1");
    const input = request();
    expect(await handle.complete(input)).toEqual(result());
    expect(input).not.toHaveProperty("credential");
    expect(calls.mock.calls[0]?.[0].credential).toBe("synthetic-provider-key");
    handle.release();
  });

  it("rotates credentials between requests made by the same Run handle", async () => {
    const { clients, calls } = setup();
    const handle = clients.acquire("organization-1", "provider-1");
    await handle.complete(request());
    const changed = executionConfiguration();
    changed.revision = 2;
    const provider = changed.providers[0];
    if (provider === undefined) throw new Error("Missing provider fixture");
    provider.credential_revision = "credential-2";
    provider.credential.secret = "rotated-synthetic-key";
    clients.apply(parseExecutionConfiguration(changed));
    await handle.complete(request());
    expect(calls.mock.calls.map(([call]) => call.credential)).toEqual([
      "synthetic-provider-key",
      "rotated-synthetic-key",
    ]);
    handle.release();
  });

  it("does not rewrite or replay a request already in flight during rotation", async () => {
    const pending = Promise.withResolvers<ModelResult>();
    const calls = vi.fn<AuthenticatedModelTransport["complete"]>(() => pending.promise);
    const clients = new ProviderClients({ complete: calls });
    clients.apply(parseExecutionConfiguration(executionConfiguration()));
    const handle = clients.acquire("organization-1", "provider-1");
    const running = handle.complete(request());
    const changed = executionConfiguration();
    changed.revision = 2;
    changed.providers = changed.providers.map((provider) => ({
      ...provider,
      credential_revision: "credential-2",
      credential: { method: "api_key", secret: "rotated" },
    }));
    clients.apply(parseExecutionConfiguration(changed));
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]?.[0].credential).toBe("synthetic-provider-key");
    pending.resolve(result());
    expect(await running).toEqual(result());
    handle.release();
  });

  it("rotates a disabled provider for existing holders without accepting new ones", async () => {
    const { clients, calls } = setup();
    const held = clients.acquire("organization-1", "provider-1");
    const fixture = executionConfiguration();
    const disabled = parseExecutionConfiguration({
      ...fixture,
      revision: 2,
      providers: fixture.providers.map((provider) => ({
        ...provider,
        enabled: false,
        credential_revision: "credential-2",
        credential: { method: "api_key", secret: "rotated-retired-key" },
      })),
    });
    clients.apply(disabled);
    expect(() => clients.acquire("organization-1", "provider-1")).toThrow("unavailable");
    await held.complete(request());
    expect(calls.mock.calls[0]?.[0].credential).toBe("rotated-retired-key");
    const conflict = parseExecutionConfiguration({
      ...disabled,
      revision: 3,
      providers: disabled.providers.map((provider) => ({
        ...provider,
        credential: { method: "api_key", secret: "conflicting-retired-key" },
      })),
    });
    expect(() => clients.apply(conflict)).toThrow("revision");
    await held.complete(request());
    expect(calls.mock.calls[1]?.[0].credential).toBe("rotated-retired-key");
    held.release();
    await expect(held.complete(request())).rejects.toThrow("released");
  });

  it("does not instantiate or retain authentication for an unheld disabled connection", async () => {
    const calls = vi.fn<AuthenticatedModelTransport["complete"]>(() => Promise.resolve(result()));
    const clients = new ProviderClients({ complete: calls });
    const fixture = executionConfiguration();
    clients.apply(
      parseExecutionConfiguration({
        ...fixture,
        providers: fixture.providers.map((provider) => ({ ...provider, enabled: false })),
      }),
    );
    expect(() => clients.acquire("organization-1", "provider-1")).toThrow("unavailable");
    expect(calls).not.toHaveBeenCalled();
    const fresh = executionConfiguration();
    fresh.providers[0]!.credential.secret = "fresh-client-key";
    clients.apply(parseExecutionConfiguration(fresh));
    const held = clients.acquire("organization-1", "provider-1");
    await held.complete(request());
    expect(calls.mock.calls[0]?.[0].credential).toBe("fresh-client-key");
    held.release();
  });

  it("retires missing providers for new acquisition while existing holders can finish", async () => {
    const { clients } = setup();
    const handle = clients.acquire("organization-1", "provider-1");
    clients.apply({
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    });
    expect(() => clients.acquire("organization-1", "provider-1")).toThrow("unavailable");
    expect(await handle.complete(request())).toEqual(result());
    handle.release();
    handle.release();
    await expect(handle.complete(request())).rejects.toThrow("released");
  });

  it("does not grant a holder merely because a request was previously allowed", () => {
    const { clients } = setup();
    clients.apply({
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    });
    expect(() => clients.acquire("organization-1", "provider-1")).toThrow("unavailable");
  });

  it("can re-enable a draining client with fresh authentication", async () => {
    const { clients, calls } = setup();
    const old = clients.acquire("organization-1", "provider-1");
    clients.apply({
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    });
    const changed = executionConfiguration();
    changed.revision = 3;
    changed.providers = changed.providers.map((provider) => ({
      ...provider,
      credential_revision: "credential-3",
      credential: { method: "api_key", secret: "restored" },
    }));
    clients.apply(parseExecutionConfiguration(changed));
    const fresh = clients.acquire("organization-1", "provider-1");
    await old.complete(request());
    old.release();
    await fresh.complete(request());
    expect(calls.mock.calls.map(([call]) => call.credential)).toEqual(["restored", "restored"]);
    fresh.release();
  });

  it("cannot close a restored client when an older request finishes late", async () => {
    const pending = Promise.withResolvers<ModelResult>();
    const calls = vi.fn<AuthenticatedModelTransport["complete"]>(() => pending.promise);
    const clients = new ProviderClients({ complete: calls });
    clients.apply(parseExecutionConfiguration(executionConfiguration()));
    const old = clients.acquire("organization-1", "provider-1");
    const running = old.complete(request());
    old.release();
    clients.apply({
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    });
    const current = executionConfiguration();
    current.revision = 3;
    clients.apply(parseExecutionConfiguration(current));
    pending.resolve(result());
    await running;
    const fresh = clients.acquire("organization-1", "provider-1");
    expect(await fresh.complete(request())).toEqual(result());
    fresh.release();
  });

  it("rejects a new target or conflicting credential on a draining connection without mutating its holders", async () => {
    const { clients, calls } = setup();
    const held = clients.acquire("organization-1", "provider-1");
    try {
      clients.apply({
        organization_id: "organization-1",
        revision: 2,
        agents: [],
        models: [],
        providers: [],
      });
      const changed = executionConfiguration();
      changed.revision = 3;
      changed.providers[0]!.base_url = "https://other-provider.example";
      changed.providers[0]!.credential_revision = "credential-3";
      changed.providers[0]!.credential.secret = "other-target-key";
      expect(() => clients.apply(parseExecutionConfiguration(changed))).toThrow("routing");
      const conflicting = executionConfiguration();
      conflicting.revision = 3;
      conflicting.providers[0]!.credential.secret = "conflicting-key";
      expect(() => clients.apply(parseExecutionConfiguration(conflicting))).toThrow("revision");
      await held.complete(request());
      expect(calls.mock.calls[0]?.[0].credential).toBe("synthetic-provider-key");
      expect(() => clients.acquire("organization-1", "provider-1")).toThrow("unavailable");
    } finally {
      held.release();
    }
  });

  it("does not share credentials or retire clients across organizations", async () => {
    const { clients, calls } = setup();
    const other = executionConfiguration();
    other.organization_id = "organization-2";
    other.providers = other.providers.map((provider) => ({
      ...provider,
      credential: { method: "api_key", secret: "other-organization-key" },
    }));
    clients.apply(parseExecutionConfiguration(other));
    const handle = clients.acquire("organization-2", "provider-1");
    clients.apply({
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    });
    await handle.complete(request());
    expect(calls.mock.calls[0]?.[0].credential).toBe("other-organization-key");
    expect(() => clients.acquire("unknown", "provider-1")).toThrow("unavailable");
    handle.release();
  });

  it("preserves model failures and releases in-flight references on rejection", async () => {
    const failure = new Error("upstream failed");
    const clients = new ProviderClients({ complete: () => Promise.reject(failure) });
    clients.apply(parseExecutionConfiguration(executionConfiguration()));
    const handle = clients.acquire("organization-1", "provider-1");
    await expect(handle.complete(request())).rejects.toBe(failure);
    handle.release();
    clients.apply({
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    });
    expect(() => clients.acquire("organization-1", "provider-1")).toThrow("unavailable");
  });
});
