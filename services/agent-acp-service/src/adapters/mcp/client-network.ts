import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

import type { FetchLike } from "@modelcontextprotocol/client";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { tracedFetch } from "../../telemetry/http.js";

export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

export type ClientMcpNetworkPolicyOptions = {
  resolve?: ResolveHost;
  blockedCidrs?: string[];
};

export class ClientMcpNetworkError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientMcpNetworkError";
  }
}

export class ClientMcpNetworkPolicy {
  private readonly resolve: ResolveHost;
  private readonly blockedNetworks: Array<ReturnType<typeof ipaddr.parseCIDR>>;

  public constructor(options: ClientMcpNetworkPolicyOptions = {}) {
    this.resolve = options.resolve ?? resolveAll;
    this.blockedNetworks = (options.blockedCidrs ?? []).map(parseCidr);
  }

  public async assertUrl(url: URL): Promise<void> {
    if (url.protocol !== "https:") {
      throw new ClientMcpNetworkError(
        "client_mcp_insecure_url",
        "Client MCP endpoints must use HTTPS",
      );
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new ClientMcpNetworkError(
        "client_mcp_embedded_credentials",
        "Client MCP URLs must not contain credentials",
      );
    }
    const hostname = stripIpv6Brackets(url.hostname);
    if (ipaddr.isValid(hostname)) {
      this.assertAddress(hostname);
      return;
    }
    const addresses = await this.resolveAddresses(hostname);
    for (const address of addresses) {
      this.assertAddress(address.address);
    }
  }

  public createLookup(): LookupFunction {
    return (hostname, options, callback) => {
      void this.resolveAddresses(hostname)
        .then((addresses) => {
          const family = typeof options.family === "number" ? options.family : 0;
          const eligible =
            family === 0 ? addresses : addresses.filter((item) => item.family === family);
          if (eligible.length === 0) {
            throw new ClientMcpNetworkError(
              "client_mcp_dns_failure",
              "Client MCP hostname has no address in the requested family",
            );
          }
          if (options.all === true) {
            callback(null, eligible);
            return;
          }
          const selected = eligible[0];
          if (selected === undefined) {
            throw new ClientMcpNetworkError(
              "client_mcp_dns_failure",
              "Client MCP hostname has no usable address",
            );
          }
          callback(null, selected.address, selected.family);
        })
        .catch((error: unknown) => {
          callback(asErrnoException(error), "", 0);
        });
    };
  }

  private async resolveAddresses(hostname: string): Promise<LookupAddress[]> {
    let addresses: LookupAddress[];
    try {
      addresses = await this.resolve(hostname);
    } catch (error) {
      throw new ClientMcpNetworkError(
        "client_mcp_dns_failure",
        "Client MCP hostname could not be resolved",
        { cause: error },
      );
    }
    if (addresses.length === 0) {
      throw new ClientMcpNetworkError(
        "client_mcp_dns_failure",
        "Client MCP hostname resolved to no addresses",
      );
    }
    for (const address of addresses) {
      this.assertAddress(address.address);
    }
    return addresses;
  }

  private assertAddress(value: string): void {
    let address: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      address = ipaddr.process(value);
    } catch (error) {
      throw new ClientMcpNetworkError(
        "client_mcp_dns_failure",
        "Client MCP hostname resolved to an invalid address",
        { cause: error },
      );
    }
    if (address.range() !== "unicast" || this.matchesBlockedNetwork(address)) {
      throw new ClientMcpNetworkError(
        "client_mcp_blocked_address",
        "Client MCP endpoint resolves to a blocked network",
      );
    }
  }

  private matchesBlockedNetwork(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
    return this.blockedNetworks.some(([network, prefix]) => {
      const normalizedNetwork = ipaddr.process(network.toString());
      return (
        address.kind() === normalizedNetwork.kind() && address.match(normalizedNetwork, prefix)
      );
    });
  }
}

type RequestWithDispatcher = (
  url: string | URL,
  init: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export type CreateClientMcpFetchOptions = {
  policy: ClientMcpNetworkPolicy;
  sensitiveHeaders: string[];
  request?: RequestWithDispatcher;
  maxRedirects?: number;
};

export type ManagedFetch = {
  fetch: FetchLike;
  close(): Promise<void>;
};

export function createClientMcpFetch(options: CreateClientMcpFetchOptions): ManagedFetch {
  const dispatcher =
    options.request === undefined
      ? new Agent({ connect: { lookup: options.policy.createLookup() } })
      : undefined;
  const request = tracedFetch(options.request ?? defaultRequest, "mcp");
  const maxRedirects = options.maxRedirects ?? 5;
  const sensitiveHeaders = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
    ...options.sensitiveHeaders.map((name) => name.toLowerCase()),
  ]);

  return {
    fetch: async (input, init = {}) => {
      let url = new URL(input);
      let method = init.method ?? "GET";
      let body = init.body;
      const headers = new Headers(init.headers);

      for (let redirect = 0; ; redirect += 1) {
        await options.policy.assertUrl(url);
        const response = await request(url, {
          ...init,
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          ...(dispatcher === undefined ? {} : { dispatcher }),
        });
        if (!isRedirect(response.status)) {
          return response;
        }
        if (redirect >= maxRedirects) {
          await discard(response);
          throw new ClientMcpNetworkError(
            "client_mcp_redirect_limit",
            "Client MCP endpoint exceeded the redirect limit",
          );
        }
        const location = response.headers.get("location");
        if (location === null) {
          return response;
        }
        const next = new URL(location, url);
        await options.policy.assertUrl(next);
        if (next.origin !== url.origin) {
          for (const header of sensitiveHeaders) {
            headers.delete(header);
          }
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
          headers.delete("content-length");
          headers.delete("content-type");
        }
        await discard(response);
        url = next;
      }
    },
    close: async () => {
      await dispatcher?.close();
    },
  };
}

async function defaultRequest(
  url: string | URL,
  init: RequestInit & { dispatcher?: Dispatcher },
): Promise<Response> {
  return (await undiciFetch(url, init as Parameters<typeof undiciFetch>[1])) as unknown as Response;
}

function resolveAll(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(addresses);
    });
  });
}

function parseCidr(value: string): ReturnType<typeof ipaddr.parseCIDR> {
  try {
    return ipaddr.parseCIDR(value);
  } catch (error) {
    throw new ClientMcpNetworkError(
      "client_mcp_invalid_blocked_cidr",
      `Invalid blocked CIDR ${value}`,
      { cause: error },
    );
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redirect response is already closed; there is nothing left to preserve.
  }
}

function asErrnoException(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error("Client MCP DNS validation failed");
}
