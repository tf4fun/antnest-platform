import { DomainError } from "../domain/errors.js";
import {
  requireSameProviderRouting,
  providerRouting,
  type ExecutionConfiguration,
  type ProviderRouting,
} from "../domain/execution-configuration.js";
import { ModelError, type AuthenticatedModelTransport, type ModelPort } from "../ports/model.js";

export interface ProviderClientHandle extends ModelPort {
  readonly signal: AbortSignal;
  release(): void;
}

type Client = {
  routing: ProviderRouting;
  credentialRevision: string;
  secret: string;
  stop: AbortController;
};

export class ProviderClients {
  private readonly organizations = new Map<string, Map<string, Client>>();

  public constructor(private readonly transport: AuthenticatedModelTransport) {}

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

  public acquire(organizationId: string, connectionId: string): ProviderClientHandle {
    const client = this.organizations.get(organizationId)?.get(connectionId);
    if (client === undefined || client.stop.signal.aborted) {
      throw new DomainError("provider_unavailable", "Provider client is unavailable");
    }
    let released = false;
    return {
      signal: client.stop.signal,
      complete: async (request) => {
        if (released) {
          throw new DomainError("provider_handle_released", "Provider client handle was released");
        }
        const signal = AbortSignal.any([request.signal, client.stop.signal]);
        signal.throwIfAborted();
        try {
          const result = await this.transport.complete({
            ...request,
            signal,
            credential: client.secret,
            ...(request.onDelta === undefined
              ? {}
              : {
                  onDelta: async (delta) => {
                    signal.throwIfAborted();
                    await request.onDelta!(delta);
                  },
                }),
          });
          if (signal.aborted) {
            const error = new ModelError(
              "model_unavailable",
              "Model request was interrupted",
              true,
              undefined,
              { cause: signal.reason },
            );
            error.usage = result.usage;
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
      release: () => {
        if (released) return;
        released = true;
      },
    };
  }
}
