import { describe, expect, it, vi } from "vitest";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { parseExecutionAuthority } from "../../src/domain/execution-publication-v2.js";
import {
  parseExecutionConfiguration,
  type ExecutionConfigurationV1,
} from "../../src/domain/execution-configuration.js";
import type { ExecutionCredentialResolver } from "../../src/ports/execution-credentials.js";
import type {
  AuthenticatedModelTransport,
  ModelRequest,
  ModelResult,
} from "../../src/ports/model.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

const resolvedSecret = "synthetic-resolved-provider-key";

function result(): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: "ok" }],
    usage: {},
    stopReason: "end_turn",
  };
}

function v2Fixture(
  overrides: { organization?: string; connection?: string; version?: string } = {},
) {
  const legacy = executionConfiguration();
  const organization = overrides.organization ?? legacy.organization_id;
  const connection = overrides.connection ?? legacy.providers[0]!.connection_id;
  const version = overrides.version ?? legacy.providers[0]!.credential_revision;
  return parseExecutionAuthority({
    ...legacy,
    organization_id: organization,
    schema_version: 2,
    providers: [
      {
        connection_id: connection,
        provider_key: "deepseek",
        request_protocol: "openai_chat_completions",
        base_url: "https://api.deepseek.com",
        enabled: true,
        credential_revision: version,
        credential: { ref: connection, version },
      },
    ],
    models: [{ ...legacy.models[0]!, connection_id: connection }],
  });
}

function legacyFixture(): ExecutionConfigurationV1 {
  return parseExecutionConfiguration(executionConfiguration());
}

function resolverStub() {
  return vi.fn<ExecutionCredentialResolver>((scope) =>
    Promise.resolve({
      organization_id: scope.organization_id,
      connection_id: scope.connection_id,
      credential_version: scope.credential_version,
      method: "api_key",
      secret: resolvedSecret,
    }),
  );
}

function transportStub() {
  const dispatched: string[] = [];
  const transport: AuthenticatedModelTransport = {
    prepare: () => ({
      reservation: {},
      complete: (credential) => {
        dispatched.push(credential());
        return Promise.resolve(result());
      },
    }),
    complete: (request) => {
      dispatched.push(request.credential);
      return Promise.resolve(result());
    },
  };
  return { transport, dispatched };
}

function request(organizationId: string, connectionId: string): ModelRequest {
  return {
    snapshot: {
      organizationId,
      providerConnectionId: connectionId,
      executionSpec: {
        model: {
          baseUrl: "https://api.deepseek.com",
          model: "test-model",
          providerTokenLimits: undefined,
        },
      },
    } as unknown as ModelRequest["snapshot"],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    signal: new AbortController().signal,
  };
}

describe("Provider reference credentials", () => {
  it("does not resolve at apply, validate, acquire or prepare", () => {
    const resolver = resolverStub();
    const { transport } = transportStub();
    const providers = new ProviderClients(transport, {}, resolver);
    const configuration = v2Fixture();
    providers.validate(configuration);
    providers.apply(configuration);
    const handle = providers.acquire("organization-1", "provider-1");
    handle.prepare!(request("organization-1", "provider-1"));
    expect(resolver).not.toHaveBeenCalled();
  });

  it("resolves once at dispatch and reuses the cache for the same scope", async () => {
    const resolver = resolverStub();
    const { transport, dispatched } = transportStub();
    const providers = new ProviderClients(transport, {}, resolver);
    providers.apply(v2Fixture());
    await providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    await providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([resolvedSecret, resolvedSecret]);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "organization-1",
        connection_id: "provider-1",
        credential_version: "credential-1",
      }),
      expect.any(AbortSignal),
    );
  });

  it("expires cached secrets after the TTL using the injected clock", async () => {
    const resolver = resolverStub();
    const { transport } = transportStub();
    let now = 1_000;
    const providers = new ProviderClients(transport, {}, resolver, () => now);
    providers.apply(v2Fixture());
    await providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    now += 60_001;
    await providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("bounds the cache and evicts the oldest scope first", async () => {
    const resolver = resolverStub();
    const { transport } = transportStub();
    const providers = new ProviderClients(transport, {}, resolver);
    const fixture = v2Fixture();
    const many = Array.from({ length: 1025 }, (_, index) => {
      const connection = `provider-${index.toString().padStart(4, "0")}`;
      const version = `v${index}`;
      return {
        connection_id: connection,
        provider_key: "deepseek" as const,
        request_protocol: "openai_chat_completions" as const,
        base_url: "https://api.deepseek.com",
        enabled: true as const,
        credential_revision: version,
        credential: { ref: connection, version },
      };
    });
    providers.apply(
      parseExecutionAuthority({
        ...structuredClone(fixture),
        providers: many,
        models: [{ ...fixture.models[0]!, connection_id: "provider-0000" }],
      }),
    );
    for (const provider of many) {
      await providers
        .acquire("organization-1", provider.connection_id)
        .complete(request("organization-1", provider.connection_id));
    }
    expect(resolver).toHaveBeenCalledTimes(1025);
    resolver.mockClear();
    await providers
      .acquire("organization-1", "provider-0000")
      .complete(request("organization-1", "provider-0000"));
    expect(resolver).toHaveBeenCalledTimes(1);
    resolver.mockClear();
    await providers
      .acquire("organization-1", "provider-1024")
      .complete(request("organization-1", "provider-1024"));
    expect(resolver).not.toHaveBeenCalled();
  });

  it("scopes cache entries to the organization", async () => {
    const resolver = resolverStub();
    const { transport } = transportStub();
    const providers = new ProviderClients(transport, {}, resolver);
    providers.apply(v2Fixture({ organization: "organization-1" }));
    providers.apply(v2Fixture({ organization: "organization-2" }));
    await providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    await providers
      .acquire("organization-2", "provider-1")
      .complete(request("organization-2", "provider-1"));
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("resolves the rotated credential version for the next Run", async () => {
    const resolver = resolverStub();
    const { transport, dispatched } = transportStub();
    const providers = new ProviderClients(transport, {}, resolver);
    providers.apply(v2Fixture());
    await providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    providers.apply(v2Fixture({ version: "credential-2" }));
    await providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenLastCalledWith(
      expect.objectContaining({ credential_version: "credential-2" }),
      expect.any(AbortSignal),
    );
    expect(dispatched).toEqual([resolvedSecret, resolvedSecret]);
  });

  it("never dispatches or repopulates the cache after rotation, disable, release or abort", async () => {
    for (const scenario of ["rotate", "disable", "abort"] as const) {
      const gate = Promise.withResolvers<void>();
      const resolver = vi.fn<ExecutionCredentialResolver>(async (scope) => {
        await gate.promise;
        return {
          organization_id: scope.organization_id,
          connection_id: scope.connection_id,
          credential_version: scope.credential_version,
          method: "api_key",
          secret: resolvedSecret,
        };
      });
      const { transport, dispatched } = transportStub();
      const providers = new ProviderClients(transport, {}, resolver);
      providers.apply(v2Fixture());
      const signal = new AbortController();
      const pending = providers.acquire("organization-1", "provider-1").complete({
        ...request("organization-1", "provider-1"),
        signal: signal.signal,
      });
      expect(resolver).toHaveBeenCalledTimes(1);
      if (scenario === "rotate") providers.apply(v2Fixture({ version: "credential-2" }));
      if (scenario === "disable") providers.apply({ ...v2Fixture(), providers: [] });
      if (scenario === "abort") signal.abort();
      gate.resolve();
      await expect(pending).rejects.toThrow();
      expect(dispatched).toHaveLength(0);
      resolver.mockClear();
      if (scenario !== "disable") {
        providers.apply(v2Fixture());
        const handle = providers.acquire("organization-1", "provider-1");
        await handle.complete(request("organization-1", "provider-1"));
        expect(resolver).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("prevents a pending prepared call from dispatching after release or mode change", async () => {
    const gate = Promise.withResolvers<void>();
    const resolver = vi.fn<ExecutionCredentialResolver>(async (scope) => {
      await gate.promise;
      return {
        organization_id: scope.organization_id,
        connection_id: scope.connection_id,
        credential_version: scope.credential_version,
        method: "api_key",
        secret: resolvedSecret,
      };
    });
    const { transport, dispatched } = transportStub();
    const providers = new ProviderClients(transport, {}, resolver);
    providers.apply(v2Fixture());
    const prepared = providers.acquire("organization-1", "provider-1").prepare!(
      request("organization-1", "provider-1"),
    );
    const pending = prepared.complete();
    prepared.release();
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(dispatched).toHaveLength(0);
    const legacy = legacyFixture();
    const modeChange = providers.acquire("organization-1", "provider-1").prepare!(
      request("organization-1", "provider-1"),
    );
    providers.apply(legacy);
    await expect(modeChange.complete()).rejects.toThrow();
    await expect(
      providers
        .acquire("organization-1", "provider-1")
        .complete(request("organization-1", "provider-1")),
    ).resolves.toBeDefined();
    expect(dispatched).toEqual(["synthetic-provider-key"]);
  });

  it("rejects late resolve results after a same-version mode change", async () => {
    const gate = Promise.withResolvers<void>();
    const resolver = vi.fn<ExecutionCredentialResolver>(async (scope) => {
      await gate.promise;
      return {
        organization_id: scope.organization_id,
        connection_id: scope.connection_id,
        credential_version: scope.credential_version,
        method: "api_key",
        secret: resolvedSecret,
      };
    });
    const { transport, dispatched } = transportStub();
    const providers = new ProviderClients(transport, {}, resolver);
    providers.apply(v2Fixture());
    const pending = providers
      .acquire("organization-1", "provider-1")
      .complete(request("organization-1", "provider-1"));
    providers.apply(legacyFixture());
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(dispatched).toEqual([]);
  });

  it("rejects a deferred credential getter after a post-resolve rotation", async () => {
    const resolver = resolverStub();
    let getter: (() => string) | undefined;
    const transport: AuthenticatedModelTransport = {
      prepare: () => ({
        reservation: {},
        complete: (credential) => {
          getter = credential;
          return Promise.resolve(result());
        },
      }),
      complete: () => Promise.reject(new Error("unreachable")),
    };
    const providers = new ProviderClients(transport, {}, resolver);
    providers.apply(v2Fixture());
    const handle = providers.acquire("organization-1", "provider-1");
    const completion = handle.complete(request("organization-1", "provider-1"));
    await vi.waitUntil(() => getter !== undefined);
    providers.apply(v2Fixture({ version: "credential-2" }));
    expect(() => getter!()).toThrow();
    await expect(completion).resolves.toBeDefined();
  });

  it("does not repopulate the cache when released after the resolver returned", async () => {
    for (const kind of ["handle", "prepared"] as const) {
      const gate = Promise.withResolvers<void>();
      const resolver = vi.fn<ExecutionCredentialResolver>(async (scope) => {
        await gate.promise;
        return {
          organization_id: scope.organization_id,
          connection_id: scope.connection_id,
          credential_version: scope.credential_version,
          method: "api_key",
          secret: resolvedSecret,
        };
      });
      const { transport, dispatched } = transportStub();
      const providers = new ProviderClients(transport, {}, resolver);
      providers.apply(v2Fixture());
      const handle = providers.acquire("organization-1", "provider-1");
      const input = request("organization-1", "provider-1");
      const completion =
        kind === "handle" ? handle.complete(input) : handle.prepare!(input).complete();
      gate.resolve();
      if (kind === "handle") handle.release();
      else handle.release();
      await expect(completion).rejects.toThrow();
      expect(dispatched).toHaveLength(0);
      resolver.mockClear();
      await providers.acquire("organization-1", "provider-1").complete(input);
      expect(resolver).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects a bound reference reservation when the credential version rotates", async () => {
    const resolver = resolverStub();
    const transport: AuthenticatedModelTransport = {
      prepare: () => ({
        reservation: { inputTokens: 1 },
        complete: () => Promise.resolve(result()),
      }),
      complete: () => Promise.reject(new Error("unreachable")),
    };
    const providers = new ProviderClients(transport, {}, resolver);
    providers.apply(v2Fixture());
    const prepared = providers.acquire("organization-1", "provider-1").prepare!(
      request("organization-1", "provider-1"),
    );
    providers.apply(v2Fixture({ version: "credential-2" }));
    await expect(prepared.complete()).rejects.toThrow("Prepared Provider authority changed");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("sanitizes a malformed resolver result instead of throwing a raw error", async () => {
    const cases: (() => Promise<unknown>)[] = [
      () => Promise.resolve(null),
      () => Promise.resolve("secret"),
      () =>
        Promise.resolve({
          organization_id: "organization-1",
          connection_id: "provider-1",
          credential_version: "credential-1",
          method: "api_key",
          secret: null,
        }),
    ];
    for (const resolve of cases) {
      const { transport, dispatched } = transportStub();
      const providers = new ProviderClients(transport, {}, resolve as ExecutionCredentialResolver);
      providers.apply(v2Fixture());
      const error = await providers
        .acquire("organization-1", "provider-1")
        .complete(request("organization-1", "provider-1"))
        .catch((candidate: unknown) => candidate);
      expect(error).toMatchObject({ code: "provider_unavailable" });
      expect(dispatched).toHaveLength(0);
    }
  });

  it("sanitizes resolver failures and invalid resolved credentials", async () => {
    const cases: {
      name: string;
      resolve: ExecutionCredentialResolver;
    }[] = [
      { name: "failure", resolve: () => Promise.reject(new Error("resolver exploded")) },
      {
        name: "wrong scope",
        resolve: (scope) =>
          Promise.resolve({
            organization_id: "other-org",
            connection_id: scope.connection_id,
            credential_version: scope.credential_version,
            method: "api_key",
            secret: resolvedSecret,
          }),
      },
      {
        name: "wrong method",
        resolve: (scope) =>
          Promise.resolve({
            organization_id: scope.organization_id,
            connection_id: scope.connection_id,
            credential_version: scope.credential_version,
            method: "bearer" as "api_key",
            secret: resolvedSecret,
          }),
      },
      {
        name: "empty secret",
        resolve: (scope) =>
          Promise.resolve({
            organization_id: scope.organization_id,
            connection_id: scope.connection_id,
            credential_version: scope.credential_version,
            method: "api_key",
            secret: "",
          }),
      },
    ];
    for (const scenario of cases) {
      const { transport, dispatched } = transportStub();
      const providers = new ProviderClients(transport, {}, scenario.resolve);
      providers.apply(v2Fixture());
      const error = await providers
        .acquire("organization-1", "provider-1")
        .complete(request("organization-1", "provider-1"))
        .catch((candidate: unknown) => candidate);
      expect(error).toMatchObject({ code: "provider_unavailable" });
      expect(JSON.stringify(error)).not.toContain(resolvedSecret);
      expect(dispatched).toEqual([]);
    }
  });

  it("fails reference dispatch safely without a resolver while legacy still works", async () => {
    const { transport, dispatched } = transportStub();
    const providers = new ProviderClients(transport);
    providers.apply(v2Fixture());
    await expect(
      providers
        .acquire("organization-1", "provider-1")
        .complete(request("organization-1", "provider-1")),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    providers.apply(legacyFixture());
    await expect(
      providers
        .acquire("organization-1", "provider-1")
        .complete(request("organization-1", "provider-1")),
    ).resolves.toBeDefined();
    expect(dispatched).toEqual(["synthetic-provider-key"]);
  });

  it("keeps the legacy same-version secret change conflict unchanged", () => {
    const { transport } = transportStub();
    const providers = new ProviderClients(transport);
    providers.apply(legacyFixture());
    const rotated = structuredClone(legacyFixture());
    const provider = rotated.providers[0]!;
    if (!("credential" in provider) || !("secret" in provider.credential))
      throw new Error("fixture requires Provider credential");
    provider.credential.secret = "different-secret-same-version";
    expect(() => providers.apply(rotated)).toThrow("credential revision");
  });
});
