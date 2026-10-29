import { DomainError } from "../domain/errors.js";
import {
  requireSameProviderRouting,
  providerRouting,
  type ExecutionConfiguration,
  type ProviderRouting,
} from "../domain/execution-configuration.js";
import {
  ModelError,
  type AuthenticatedModelTransport,
  type ModelPort,
  type ModelRequest,
  type PreparedModelCall,
} from "../ports/model.js";
import { matchingProviderTokenLimits } from "../domain/provider-token-limits.js";
import type {
  ExecutionCredentialResolver,
  ResolvedExecutionCredential,
} from "../ports/execution-credentials.js";
import type { ProviderCircuitPermit, ProviderCircuitPort } from "../ports/provider-circuit.js";
import { ProviderCircuit, type ProviderCircuitOptions } from "./provider-circuit.js";

export interface ProviderClientHandle extends ModelPort {
  readonly signal: AbortSignal;
  release(): void;
}

type Client = {
  routing: ProviderRouting;
  credentialRevision: string;
  mode: "legacy" | "reference";
  generation: number;
  secret: string;
  stop: AbortController;
  circuit: ProviderCircuit;
};

type ResolvedSecret = { secret: string; expiresAt: number };
const RESOLVED_TTL_MS = 60_000;
const RESOLVED_MAX = 1024;

export class ProviderClients implements ProviderCircuitPort {
  private readonly organizations = new Map<string, Map<string, Client>>();
  private readonly circuitOptions: ProviderCircuitOptions;
  private readonly resolved = new Map<string, ResolvedSecret>();

  public constructor(
    private readonly transport: AuthenticatedModelTransport,
    circuitOptions: ProviderCircuitOptions = {},
    private readonly resolver?: ExecutionCredentialResolver,
    private readonly now: () => number = Date.now,
  ) {
    this.circuitOptions = { ...circuitOptions };
  }

  private invalidateResolved(organizationId: string, connectionId: string): void {
    const prefix = JSON.stringify([organizationId, connectionId]);
    for (const key of this.resolved.keys()) {
      if (key.startsWith(prefix.slice(0, -1))) this.resolved.delete(key);
    }
  }

  private async resolveSecret(
    client: Client,
    organizationId: string,
    connectionId: string,
    signal: AbortSignal,
    guard: () => void,
  ): Promise<string> {
    const resolver = this.resolver;
    if (resolver === undefined)
      throw new ModelError("provider_unavailable", "Provider credential is unavailable", false);
    const generation = client.generation;
    const version = client.credentialRevision;
    const scope = {
      organization_id: organizationId,
      connection_id: connectionId,
      credential_version: version,
    };
    const key = JSON.stringify([
      scope.organization_id,
      scope.connection_id,
      scope.credential_version,
    ]);
    const cached = this.resolved.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > this.now()) {
        guard();
        return cached.secret;
      }
      this.resolved.delete(key);
    }
    let credential: unknown;
    try {
      credential = await resolver(scope, signal);
    } catch {
      throw new ModelError("provider_unavailable", "Provider credential is unavailable", false);
    }
    if (
      signal.aborted ||
      client.stop.signal.aborted ||
      client.generation !== generation ||
      client.mode !== "reference" ||
      client.credentialRevision !== version ||
      credential === null ||
      typeof credential !== "object"
    )
      throw new ModelError("provider_unavailable", "Provider credential is unavailable", false);
    const candidate = credential as ResolvedExecutionCredential;
    if (
      candidate.organization_id !== scope.organization_id ||
      candidate.connection_id !== scope.connection_id ||
      candidate.credential_version !== scope.credential_version ||
      candidate.method !== "api_key" ||
      typeof candidate.secret !== "string" ||
      candidate.secret === ""
    )
      throw new ModelError("provider_unavailable", "Provider credential is unavailable", false);
    guard();
    if (this.resolved.size >= RESOLVED_MAX)
      this.resolved.delete(this.resolved.keys().next().value!);
    this.resolved.set(key, { secret: candidate.secret, expiresAt: this.now() + RESOLVED_TTL_MS });
    return candidate.secret;
  }

  public validate(snapshot: ExecutionConfiguration): void {
    const clients = this.organizations.get(snapshot.organization_id);
    for (const provider of snapshot.providers) {
      const client = clients?.get(provider.connection_id);
      if (client === undefined) continue;
      requireSameProviderRouting(client.routing, provider);
      if (
        client.mode === "legacy" &&
        "credential" in provider &&
        "secret" in provider.credential &&
        client.credentialRevision === provider.credential_revision &&
        client.secret !== provider.credential.secret
      ) {
        throw new DomainError(
          "configuration_conflict",
          "Provider authentication requires a new credential revision",
        );
      }
    }
  }

  public apply(snapshot: ExecutionConfiguration): void {
    this.validate(snapshot);
    const clients = this.organizations.get(snapshot.organization_id) ?? new Map<string, Client>();
    this.organizations.set(snapshot.organization_id, clients);
    const enabled = new Set(
      snapshot.providers
        .filter((provider) => provider.enabled)
        .map((provider) => provider.connection_id),
    );
    for (const [id, client] of clients) {
      if (enabled.has(id)) continue;
      clients.delete(id);
      client.secret = "";
      this.invalidateResolved(snapshot.organization_id, id);
      client.stop.abort(
        new DomainError(
          "provider_unavailable",
          "Provider was disabled; this execution cannot continue",
        ),
      );
    }
    for (const provider of snapshot.providers) {
      if (!provider.enabled) continue;
      let client = clients.get(provider.connection_id);
      if (client === undefined) {
        client = {
          routing: providerRouting(provider),
          credentialRevision: provider.credential_revision,
          mode:
            "credential" in provider && "secret" in provider.credential ? "legacy" : "reference",
          generation: 0,
          secret: "",
          stop: new AbortController(),
          circuit: new ProviderCircuit(this.circuitOptions),
        };
      }
      if ("credential" in provider) {
        const mode = "secret" in provider.credential ? ("legacy" as const) : ("reference" as const);
        const version = provider.credential_revision;
        if (client.mode !== mode || client.credentialRevision !== version) {
          client.generation += 1;
          this.invalidateResolved(snapshot.organization_id, provider.connection_id);
        }
        client.mode = mode;
        client.secret = "secret" in provider.credential ? provider.credential.secret : "";
        client.credentialRevision = version;
      }
      clients.set(provider.connection_id, client);
    }
    if (clients.size === 0) this.organizations.delete(snapshot.organization_id);
  }

  public tryModelAttempt(
    organizationId: string,
    connectionId: string,
    baseUrl: string,
  ): ProviderCircuitPermit | undefined {
    const client = this.organizations.get(organizationId)?.get(connectionId);
    if (client === undefined || client.stop.signal.aborted || client.routing.base_url !== baseUrl)
      throw new ModelError("provider_unavailable", "Provider client is unavailable", false);
    return client.circuit.tryAcquire();
  }

  public acquire(organizationId: string, connectionId: string): ProviderClientHandle {
    const client = this.organizations.get(organizationId)?.get(connectionId);
    if (client === undefined || client.stop.signal.aborted) {
      throw new DomainError("provider_unavailable", "Provider client is unavailable");
    }
    let released = false;
    const prepare = (request: ModelRequest): PreparedModelCall => {
      const signal = AbortSignal.any([request.signal, client.stop.signal]);
      const input: ModelRequest = {
        ...request,
        signal,
        snapshot: structuredClone(request.snapshot),
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
        ...(request.onDelta === undefined
          ? {}
          : {
              onDelta: async (delta) => {
                signal.throwIfAborted();
                await request.onDelta!(delta);
              },
            }),
      };
      const assertCurrent = (): void => {
        if (released)
          throw new DomainError("provider_handle_released", "Provider client handle was released");
        signal.throwIfAborted();
        if (
          input.snapshot.organizationId !== organizationId ||
          input.snapshot.providerConnectionId !== connectionId ||
          input.snapshot.executionSpec.model.baseUrl !== client.routing.base_url
        )
          throw new ModelError(
            "provider_unavailable",
            "Provider routing does not match the frozen Run",
            false,
          );
      };
      assertCurrent();
      const limits = matchingProviderTokenLimits(
        input.snapshot.executionSpec.model.providerTokenLimits,
        {
          organization_id: organizationId,
          connection_id: connectionId,
          provider_key: client.routing.provider_key,
          request_protocol: client.routing.request_protocol,
          base_url: client.routing.base_url,
          model: input.snapshot.executionSpec.model.model,
          credential_revision: client.credentialRevision,
        },
      );
      const operation = this.transport.prepare?.(input, limits);
      const reservation = Object.freeze({ ...operation?.reservation });
      const boundRevision = client.credentialRevision;
      const preparedMode = client.mode;
      const bound = reservation.inputTokens !== undefined || reservation.outputTokens !== undefined;
      let disposed: boolean = false;
      let consumed = false;
      let delegated = false;
      return {
        reservation,
        get dispatchState() {
          return operation?.dispatchState ?? (delegated ? undefined : "not_dispatched");
        },
        release: () => {
          disposed = true;
        },
        complete: async () => {
          if (disposed || consumed)
            throw new DomainError(
              "provider_handle_released",
              "Prepared Provider request is no longer available",
            );
          consumed = true;
          assertCurrent();
          if (client.mode !== preparedMode)
            throw new ModelError(
              "provider_unavailable",
              "Prepared Provider authority changed",
              false,
            );
          try {
            const checkBound = (): void => {
              if (bound && client.credentialRevision !== boundRevision)
                throw new ModelError(
                  "provider_unavailable",
                  "Prepared Provider authority changed",
                  false,
                );
            };
            const reference =
              client.mode === "reference"
                ? { generation: client.generation, version: client.credentialRevision }
                : undefined;
            if (reference !== undefined) checkBound();
            const guard = (): void => {
              assertCurrent();
              if (disposed || (bound && client.credentialRevision !== boundRevision))
                throw new ModelError(
                  "provider_unavailable",
                  "Prepared Provider authority changed",
                  false,
                );
              if (
                reference !== undefined &&
                (client.mode !== "reference" ||
                  client.generation !== reference.generation ||
                  client.credentialRevision !== reference.version)
              )
                throw new ModelError(
                  "provider_unavailable",
                  "Prepared Provider authority changed",
                  false,
                );
            };
            const secret =
              reference === undefined
                ? client.secret
                : await this.resolveSecret(client, organizationId, connectionId, signal, guard);
            const resolved = secret;
            const credential = (): string => {
              if (reference !== undefined) guard();
              else assertCurrent();
              if (disposed || (bound && client.credentialRevision !== boundRevision))
                throw new ModelError(
                  "provider_unavailable",
                  "Prepared Provider authority changed",
                  false,
                );
              if (reference !== undefined) {
                if (
                  client.mode !== "reference" ||
                  client.generation !== reference.generation ||
                  client.credentialRevision !== reference.version
                )
                  throw new ModelError(
                    "provider_unavailable",
                    "Prepared Provider authority changed",
                    false,
                  );
                return resolved;
              }
              return client.secret;
            };
            // Legacy transports cannot prove whether a delegated request was sent.
            const legacyCredential = operation === undefined ? credential() : undefined;
            delegated = true;
            const result =
              operation === undefined
                ? await this.transport.complete({ ...input, credential: legacyCredential! })
                : await operation.complete(credential);
            if (signal.aborted) {
              const error = new ModelError(
                "model_unavailable",
                "Model request was interrupted",
                true,
                undefined,
                { cause: signal.reason },
              );
              error.usage = result.usage;
              error.outputStarted =
                [...result.content, ...(result.thought ?? [])].some(
                  (block) =>
                    block.type !== "text" ||
                    (typeof block.text === "string" && block.text.length > 0),
                ) ||
                (result.kind === "tool_calls" && result.calls.length > 0);
              throw error;
            }
            return result;
          } catch (error) {
            // The transport owns cancellation and can attach usage received before abort.
            if (error instanceof ModelError) throw error;
            signal.throwIfAborted();
            throw error;
          }
        },
      };
    };
    return {
      signal: client.stop.signal,
      prepare,
      complete: async (request) => {
        const prepared = prepare(request);
        try {
          return await prepared.complete();
        } finally {
          prepared.release();
        }
      },
      release: () => {
        if (released) return;
        released = true;
      },
    };
  }
}
