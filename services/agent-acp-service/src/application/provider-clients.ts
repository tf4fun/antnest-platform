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
import type { ProviderCircuitPermit, ProviderCircuitPort } from "../ports/provider-circuit.js";
import { ProviderCircuit, type ProviderCircuitOptions } from "./provider-circuit.js";

export interface ProviderClientHandle extends ModelPort {
  readonly signal: AbortSignal;
  release(): void;
}

type Client = {
  routing: ProviderRouting;
  credentialRevision: string;
  secret: string;
  stop: AbortController;
  circuit: ProviderCircuit;
};

export class ProviderClients implements ProviderCircuitPort {
  private readonly organizations = new Map<string, Map<string, Client>>();
  private readonly circuitOptions: ProviderCircuitOptions;

  public constructor(
    private readonly transport: AuthenticatedModelTransport,
    circuitOptions: ProviderCircuitOptions = {},
  ) {
    this.circuitOptions = { ...circuitOptions };
  }

  public validate(snapshot: ExecutionConfiguration): void {
    const clients = this.organizations.get(snapshot.organization_id);
    for (const provider of snapshot.providers) {
      const client = clients?.get(provider.connection_id);
      if (client === undefined) continue;
      requireSameProviderRouting(client.routing, provider);
      if (
        "credential" in provider &&
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
          secret: "",
          stop: new AbortController(),
          circuit: new ProviderCircuit(this.circuitOptions),
        };
      }
      if ("credential" in provider) {
        client.secret = provider.credential.secret;
        client.credentialRevision = provider.credential_revision;
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
      const bound = reservation.inputTokens !== undefined || reservation.outputTokens !== undefined;
      let disposed = false;
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
          try {
            const credential = (): string => {
              assertCurrent();
              if (disposed || (bound && client.credentialRevision !== boundRevision))
                throw new ModelError(
                  "provider_unavailable",
                  "Prepared Provider authority changed",
                  false,
                );
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
