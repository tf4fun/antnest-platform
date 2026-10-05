import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { ModelError } from "../../ports/model.js";

// These ranges are frozen by the shared platform policy and checked against
// the same decision vectors as Controller; do not infer policy from a URL alone.
const privateRanges = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
].map((value) => ipaddr.parseCIDR(value));
const deniedRanges = [
  "0.0.0.0/8",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "100:0:0:1::/64",
  "2001::/32",
  "2001:2::/48",
  "2001:10::/28",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "ff00::/8",
].map((value) => ipaddr.parseCIDR(value));

export type ProviderResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;
export type ProviderDestinationOptions = {
  allowPrivateEndpoints?: boolean;
  resolve?: ProviderResolver;
  lookupTimeoutMs?: number;
};
export type ProviderEndpoint = { url: URL; addresses: readonly string[] };

export function providerBaseUrl(raw: string): URL {
  try {
    for (const character of raw)
      if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        throw new Error("invalid");
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(raw)?.[1];
    const endpoint = new URL(raw);
    if (
      !authority ||
      raw.trim() !== raw ||
      /[\s\\?#]/u.test(raw) ||
      /[%@]/u.test(authority) ||
      authority.endsWith(":") ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      !endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.port === "0"
    )
      throw new Error("invalid");
    return endpoint;
  } catch {
    throw forbidden();
  }
}

export function providerAddressAllowed(raw: string, allowPrivate: boolean): boolean {
  if (isIP(raw) === 0 || raw.includes("%")) return false;
  const address = ipaddr.process(raw);
  const matches = (ranges: typeof privateRanges) =>
    ranges.some(
      ([network, bits]) => address.kind() === network.kind() && address.match(network, bits),
    );
  return !matches(deniedRanges) && (allowPrivate || !matches(privateRanges));
}

export class ProviderDestinationPolicy {
  private readonly resolve: ProviderResolver;
  private readonly allowPrivate: boolean;
  private readonly lookupTimeoutMs: number;

  public constructor(options: ProviderDestinationOptions = {}) {
    this.resolve =
      options.resolve ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address));
    this.allowPrivate = options.allowPrivateEndpoints ?? false;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.lookupTimeoutMs) ||
      this.lookupTimeoutMs < 1 ||
      this.lookupTimeoutMs > 30_000
    )
      throw new Error("Provider lookup timeout must be between 1 and 30000ms");
  }

  public async prepare(raw: string, signal: AbortSignal): Promise<ProviderEndpoint> {
    const url = providerBaseUrl(raw);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    let addresses: string[];
    if (isIP(hostname)) {
      signal.throwIfAborted();
      addresses = [hostname];
    } else {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.lookupTimeoutMs)]);
      const interrupted = Promise.withResolvers<never>();
      const abort = () => interrupted.reject(unavailable());
      try {
        bounded.throwIfAborted();
        bounded.addEventListener("abort", abort, { once: true });
        addresses = await Promise.race([this.resolve(hostname, bounded), interrupted.promise]);
      } catch {
        throw unavailable();
      } finally {
        bounded.removeEventListener("abort", abort);
      }
    }
    if (addresses.length === 0) throw unavailable();
    if (addresses.some((address) => !providerAddressAllowed(address, this.allowPrivate)))
      throw forbidden();
    return {
      url,
      addresses: Object.freeze([
        ...new Set(addresses.map((address) => ipaddr.process(address).toString())),
      ]),
    };
  }
}

function forbidden(): ModelError {
  return new ModelError("provider_endpoint_forbidden", "Provider endpoint is forbidden", false);
}
function unavailable(): ModelError {
  return new ModelError("provider_endpoint_unavailable", "Provider endpoint is unavailable", true);
}
