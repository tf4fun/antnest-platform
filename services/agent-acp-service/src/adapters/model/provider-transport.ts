import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { ProviderEndpoint } from "./destination-policy.js";
import { ModelError } from "../../ports/model.js";

export type ProviderFetch = (input: string, init: RequestInit) => Promise<Response>;

// One bounded dispatcher per completion: it lives through streamed body reads,
// then is destroyed by the model's finally block. No DNS/proxy/global dispatcher
// or private service credentials can be reused for a Provider connection.
export class PinnedProviderTransport {
  private readonly agent: Agent;
  private readonly origin: string;

  public constructor(endpoint: ProviderEndpoint, connect?: ReturnType<typeof buildConnector>) {
    this.origin = endpoint.url.origin;
    const hostname = endpoint.url.hostname.replace(/^\[|\]$/gu, "");
    const dial =
      connect ??
      buildConnector({
        timeout: 10_000,
        checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
      });
    const address = endpoint.addresses.find((value) => isIP(value) === 4) ?? endpoint.addresses[0];
    if (!address)
      throw new ModelError(
        "provider_endpoint_unavailable",
        "Provider endpoint is unavailable",
        true,
      );
    this.agent = new Agent({
      connections: 1,
      maxOrigins: 1,
      connect: (options, callback) => {
        if (options.hostname.replace(/^\[|\]$/gu, "") !== hostname) {
          callback(
            new ModelError("provider_endpoint_forbidden", "Provider endpoint is forbidden", false),
            null,
          );
          return;
        }
        dial(
          { ...options, hostname: address, ...(isIP(hostname) ? {} : { servername: hostname }) },
          callback,
        );
      },
    });
  }

  public readonly fetch: ProviderFetch = async (input, init) => {
    if (new URL(input).origin !== this.origin)
      throw new ModelError("provider_endpoint_forbidden", "Provider endpoint is forbidden", false);
    const headers = new Headers(init.headers);
    headers.delete("host");
    for (const name of [...headers.keys()])
      if (
        name.startsWith("antnest-") ||
        name.startsWith("x-antnest-") ||
        name === "cookie" ||
        name === "baggage"
      )
        headers.delete(name);
    return (await undiciFetch(input, {
      ...init,
      headers: Object.fromEntries(headers),
      redirect: "manual",
      credentials: "omit",
      dispatcher: this.agent,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  };

  public async close(): Promise<void> {
    await this.agent.destroy();
  }
}
