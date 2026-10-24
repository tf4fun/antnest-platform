import { describe, expect, it, vi } from "vitest";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { parseExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import {
  ModelError,
  type AuthenticatedModelTransport,
  type ModelRequest,
  type ModelResult,
} from "../../src/ports/model.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { snapshot } from "../support/fixtures.js";

function request(organizationId = "organization-1"): ModelRequest {
  const frozen = snapshot();
  const provider = executionConfiguration().providers[0]!;
  frozen.organizationId = organizationId;
  frozen.providerConnectionId = provider.connection_id;
  frozen.executionSpec.model.baseUrl = provider.base_url;
  return { snapshot: frozen, messages: [], tools: [], signal: new AbortController().signal };
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

  it("discards authentication updates for disabled clients and revokes existing holders", async () => {
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
    await expect(held.complete(request())).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(calls).not.toHaveBeenCalled();
    const conflict = parseExecutionConfiguration({
      ...disabled,
      revision: 3,
      providers: disabled.providers.map((provider) => ({
        ...provider,
        credential: { method: "api_key", secret: "conflicting-retired-key" },
      })),
    });
    clients.apply(conflict);
    await expect(held.complete(request())).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(calls).not.toHaveBeenCalled();
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

  it("revokes missing providers including existing holders", async () => {
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
    await expect(handle.complete(request())).rejects.toMatchObject({
      code: "provider_unavailable",
    });
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

  it("re-enables only fresh handles without reviving old ones", async () => {
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
    await expect(old.complete(request())).rejects.toMatchObject({ code: "provider_unavailable" });
    old.release();
    await fresh.complete(request());
    expect(calls.mock.calls.map(([call]) => call.credential)).toEqual(["restored"]);
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
    pending.resolve({ ...result(), usage: { inputTokens: 4, outputTokens: 1 } });
    await expect(running).rejects.toMatchObject({
      code: "model_unavailable",
      usage: { inputTokens: 4, outputTokens: 1 },
      cause: { code: "provider_unavailable" },
    });
    const fresh = clients.acquire("organization-1", "provider-1");
    expect(await fresh.complete(request())).toMatchObject({
      kind: "message",
      stopReason: "end_turn",
    });
    fresh.release();
  });

  it("rejects a new target or conflicting credential on an active connection without mutating holders", async () => {
    const { clients, calls } = setup();
    const held = clients.acquire("organization-1", "provider-1");
    try {
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
      clients.acquire("organization-1", "provider-1").release();
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
    await handle.complete(request("organization-2"));
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

function circuitSetup() {
  let elapsed = 0;
  const calls = vi.fn<AuthenticatedModelTransport["complete"]>(() => Promise.resolve(result()));
  const clients = new ProviderClients(
    { complete: calls },
    { failureThreshold: 1, cooldownMs: 10, now: () => elapsed },
  );
  clients.apply(parseExecutionConfiguration(executionConfiguration()));
  return {
    clients,
    calls,
    advance: (milliseconds: number): void => {
      elapsed += milliseconds;
    },
  };
}

function attemptPermit(
  clients: ProviderClients,
  organizationId = "organization-1",
  connectionId = "provider-1",
) {
  const baseUrl = executionConfiguration().providers[0]!.base_url;
  const permit = clients.tryModelAttempt(organizationId, connectionId, baseUrl);
  expect(permit).toBeDefined();
  if (permit === undefined) throw new Error("Expected a Provider model-attempt permit");
  return permit;
}

describe("Provider client circuit binding", () => {
  it("opens the default circuit after three failed model attempts", () => {
    const { clients, calls } = setup();
    expect(attemptPermit(clients).settle("failure")).toBe(false);
    expect(attemptPermit(clients).settle("failure")).toBe(false);
    expect(attemptPermit(clients).settle("failure")).toBe(true);
    expect(
      clients.tryModelAttempt(
        "organization-1",
        "provider-1",
        executionConfiguration().providers[0]!.base_url,
      ),
    ).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
  });

  it("keeps connections independent within the same organization", () => {
    const { clients, calls } = circuitSetup();
    const publication = executionConfiguration();
    publication.revision = 2;
    publication.providers.push({
      ...publication.providers[0]!,
      connection_id: "provider-2",
      credential: { method: "api_key", secret: "second-synthetic-provider-key" },
    });
    clients.apply(parseExecutionConfiguration(publication));
    expect(attemptPermit(clients).settle("failure")).toBe(true);
    expect(attemptPermit(clients, "organization-1", "provider-2").settle("success")).toBe(false);
    expect(
      clients.tryModelAttempt("organization-1", "provider-1", publication.providers[0]!.base_url),
    ).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
  });

  it("keeps the same connection identifier independent across organizations", () => {
    const { clients, calls } = circuitSetup();
    const other = executionConfiguration();
    other.organization_id = "organization-2";
    clients.apply(parseExecutionConfiguration(other));
    expect(attemptPermit(clients).settle("failure")).toBe(true);
    expect(attemptPermit(clients, "organization-2").settle("success")).toBe(false);
    expect(
      clients.tryModelAttempt("organization-1", "provider-1", other.providers[0]!.base_url),
    ).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
  });

  it("preserves an open circuit across ordinary publication and credential rotation", () => {
    const { clients } = circuitSetup();
    expect(attemptPermit(clients).settle("failure")).toBe(true);
    const publication = executionConfiguration();
    publication.revision = 2;
    clients.apply(parseExecutionConfiguration(publication));
    const baseUrl = publication.providers[0]!.base_url;
    expect(clients.tryModelAttempt("organization-1", "provider-1", baseUrl)).toBeUndefined();
    publication.revision = 3;
    publication.providers[0]!.credential_revision = "credential-3";
    publication.providers[0]!.credential.secret = "rotated-synthetic-provider-key";
    clients.apply(parseExecutionConfiguration(publication));
    expect(clients.tryModelAttempt("organization-1", "provider-1", baseUrl)).toBeUndefined();
  });

  it("starts a fresh circuit after a removed connection is rebuilt", () => {
    const { clients } = circuitSetup();
    expect(attemptPermit(clients).settle("failure")).toBe(true);
    clients.apply(
      parseExecutionConfiguration({
        organization_id: "organization-1",
        revision: 2,
        agents: [],
        models: [],
        providers: [],
      }),
    );
    const replacement = executionConfiguration();
    replacement.revision = 3;
    clients.apply(parseExecutionConfiguration(replacement));
    expect(attemptPermit(clients).settle("success")).toBe(false);
  });

  it.each(["success", "failure"] as const)(
    "does not apply a removed client's late %s to its replacement circuit",
    (outcome) => {
      const { clients } = circuitSetup();
      const original = attemptPermit(clients);
      clients.apply(
        parseExecutionConfiguration({
          organization_id: "organization-1",
          revision: 2,
          agents: [],
          models: [],
          providers: [],
        }),
      );
      const replacement = executionConfiguration();
      replacement.revision = 3;
      clients.apply(parseExecutionConfiguration(replacement));
      const current = attemptPermit(clients);
      if (outcome === "success") {
        expect(current.settle("failure")).toBe(true);
        original.settle(outcome);
        expect(
          clients.tryModelAttempt(
            "organization-1",
            "provider-1",
            replacement.providers[0]!.base_url,
          ),
        ).toBeUndefined();
      } else {
        original.settle(outcome);
        expect(attemptPermit(clients).settle("neutral")).toBe(false);
        expect(current.settle("neutral")).toBe(false);
      }
    },
  );

  it("does not abort holders or spend the half-open probe on preparation acquire", () => {
    const { clients, calls, advance } = circuitSetup();
    const original = clients.acquire("organization-1", "provider-1");
    const handles = [original];
    try {
      expect(attemptPermit(clients).settle("failure")).toBe(true);
      expect(original.signal.aborted).toBe(false);
      const duringCooldown = clients.acquire("organization-1", "provider-1");
      handles.push(duringCooldown);
      expect(duringCooldown.signal.aborted).toBe(false);
      advance(10);
      const preparation = clients.acquire("organization-1", "provider-1");
      handles.push(preparation);
      expect(preparation.signal.aborted).toBe(false);
      const probe = attemptPermit(clients);
      try {
        expect(
          clients.tryModelAttempt(
            "organization-1",
            "provider-1",
            executionConfiguration().providers[0]!.base_url,
          ),
        ).toBeUndefined();
        expect(handles.every((handle) => !handle.signal.aborted)).toBe(true);
        expect(calls).not.toHaveBeenCalled();
      } finally {
        probe.settle("neutral");
      }
    } finally {
      for (const handle of handles) handle.release();
    }
  });

  it.each(["missing organization", "missing connection", "disabled", "changed routing"] as const)(
    "throws a non-retryable Provider error instead of a circuit denial for %s",
    (mode) => {
      const { clients, calls } = circuitSetup();
      expect(attemptPermit(clients).settle("failure")).toBe(true);
      const fixture = executionConfiguration();
      if (mode === "disabled")
        clients.apply(
          parseExecutionConfiguration({
            ...fixture,
            revision: 2,
            providers: fixture.providers.map((provider) => ({ ...provider, enabled: false })),
          }),
        );
      let failure: unknown;
      try {
        clients.tryModelAttempt(
          mode === "missing organization" ? "missing-organization" : "organization-1",
          mode === "missing connection" ? "missing-provider" : "provider-1",
          mode === "changed routing"
            ? "https://other-provider.example"
            : fixture.providers[0]!.base_url,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ModelError);
      if (!(failure instanceof ModelError))
        throw new Error("Expected a Provider authorization failure");
      expect(failure.code).toBe("provider_unavailable");
      expect(failure.retryable).toBe(false);
      expect(calls).not.toHaveBeenCalled();
    },
  );
});
