import { DomainError } from "../domain/errors.js";
import {
  requireSameProviderRouting,
  providerRouting,
  type ExecutionConfiguration,
  type ProviderRouting,
} from "../domain/execution-configuration.js";
import type { AuthenticatedModelTransport, ModelPort } from "../ports/model.js";

export interface ProviderClientHandle extends ModelPort {
  release(): void;
}

type Client = {
  routing: ProviderRouting;
  credentialRevision: string;
  secret: string;
  accepting: boolean;
  holders: number;
  inFlight: number;
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
    for (const client of clients.values()) client.accepting = false;
    for (const provider of snapshot.providers) {
      let client = clients.get(provider.connection_id);
      if (client === undefined) {
        if (!provider.enabled) continue;
        client = {
          routing: providerRouting(provider),
          credentialRevision: provider.credential_revision,
          secret: "",
          accepting: false,
          holders: 0,
          inFlight: 0,
        };
      }
      if ("credential" in provider) {
        client.secret = provider.credential.secret;
        client.credentialRevision = provider.credential_revision;
      }
      client.accepting = provider.enabled;
      clients.set(provider.connection_id, client);
    }
    for (const [connectionId, client] of clients) {
      this.collect(snapshot.organization_id, connectionId, client);
    }
  }

  public acquire(organizationId: string, connectionId: string): ProviderClientHandle {
    const client = this.organizations.get(organizationId)?.get(connectionId);
    if (client?.accepting !== true) {
      throw new DomainError("provider_unavailable", "Provider client is unavailable");
    }
    client.holders += 1;
    let released = false;
    return {
      complete: async (request) => {
        if (released) {
          throw new DomainError("provider_handle_released", "Provider client handle was released");
        }
        client.inFlight += 1;
        try {
          return await this.transport.complete({ ...request, credential: client.secret });
        } finally {
          client.inFlight -= 1;
          this.collect(organizationId, connectionId, client);
        }
      },
      release: () => {
        if (released) return;
        released = true;
        client.holders -= 1;
        this.collect(organizationId, connectionId, client);
      },
    };
  }

  private collect(organizationId: string, connectionId: string, client: Client): void {
    if (client.accepting || client.holders !== 0 || client.inFlight !== 0) return;
    client.secret = "";
    const clients = this.organizations.get(organizationId);
    if (clients?.get(connectionId) !== client) return;
    clients.delete(connectionId);
    if (clients.size === 0) this.organizations.delete(organizationId);
  }
}
