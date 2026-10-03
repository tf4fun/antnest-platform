# Provider destination policy

Policy version 1 is the shared contract for #28, delivered before its Controller
and ACP implementations. Their independent adapters must run the same
[fixtures](provider-destination-fixtures.json). This contract does not describe a
receiver or consumer that has not passed its owning-service gates as implemented.

## Endpoint and address decisions

Accept only an absolute HTTP(S) URL with a host, optional ordinary base path and
a valid port (1–65535). Reject opaque URLs, user info, query, fragment, surrounding
whitespace, percent-encoded hosts and scoped IPv6 addresses. The policy is applied
at Provider connection creation, saved/draft discovery and actual ACP model calls.
Missing fields still use the owning wire contract's request validation.

Parse IP literals without DNS. Unmap IPv4-mapped IPv6 before classification.
For names, resolve all A/AAAA addresses under the existing operation deadline;
reject the entire result if any answer is forbidden, including mixed public and
private answers. An empty answer set or lookup failure is a retryable dependency
failure. There is no fallback to an unchecked hostname or system proxy.

The fixture's prefix arrays are the frozen platform rules. By default both
`private_prefixes` and `always_denied_prefixes` are rejected. Ordinary unicast
addresses outside those lists are allowed. Private prefixes cover loopback,
RFC1918, CGNAT, link local, ULA and legacy site local; common metadata addresses
are covered by these ranges. Permanently denied prefixes cover unspecified,
multicast, documentation/reserved/benchmarking and transition/translation ranges.
Translation prefixes are conservatively blocked to avoid embedded-address
bypasses. These are platform rules rather than an automatic copy of every IANA
exception; their factual address classifications come from the
[IANA IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
and [IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/).

Only the operator's exact `ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS=true` enables
`private_prefixes`, for local LLM deployments. Absent means false; exact false is
valid; present empty, whitespace or other spellings fail startup. This option is
unsafe for multi-tenant deployments and also permits metadata addresses within
those ranges. It never permits scoped, unspecified, reserved or multicast
addresses. Browser requests, Agent/Template data and Provider input cannot enable
it. This option is separate from the service authentication transport opt-in.

## Connect without a second resolution

After validating a name, select only a verified address and dial its literal IP
and original port. Preserve the original hostname for TLS verification, SNI and
HTTP Host. A validating lookup followed by an ordinary hostname dial is forbidden:
that second resolution would reopen DNS rebinding. Reused connections remain
bound to the socket established from verified addresses; every new connection
uses the same decision before dialing. Each outgoing request revalidates its
destination before any secret is transmitted.

Redirects remain disabled, including same-origin redirects. Environment HTTP(S)
proxies are disabled for Provider transport. Do not reuse workload-authenticated
internal service transports for Provider calls, and never forward service tokens,
CCT, cookies or incoming user Authorization to the Provider. The only outbound
credential is the selected Provider's own protocol authorization. At connection
creation the check resolves only; it sends no Provider credential or HTTP request.

Discovery retains a deadline and an 8 MiB response cap. ACP retains its existing
model request/stream limits and cancellation. Failures expose a bounded error
class, never the key, complete URL, raw Provider body or transport error.

| Error | HTTP | Retryable | Meaning |
| --- | --- | --- | --- |
| `provider_endpoint_forbidden` | 422 | false | Static URL/address policy denial, before any credential is sent |
| `provider_endpoint_unavailable` | 503 | true | DNS resolution failed or returned no usable answers |
| `provider_discovery_failed` | 502 | true | Checked discovery transport/status/body failed |

ACP maps these classes into its existing bounded Run failure path instead of
introducing another browser HTTP envelope.

## Ordered delivery

1. Freeze this policy and fixture decisions; no production code in this batch.
2. Controller: move discovery next to encrypted credentials; return only models;
   add saved/draft routes and schemas; remove `/access`; guard creation/discovery.
3. Console: keep browser JSON unchanged, replace discovery with thin Controller
   proxy calls, remove its outbound Provider transport and decrypted-key reader.
4. ACP: apply the identical policy to actual model transport, independently of
   Controller validation, including rebind/pinning and error hygiene.
5. After all own gates pass, run final Docker/Console discovery and model-call
   acceptance. A draft targeting Identity must fail; normal model fixtures must
   succeed. Isolated tests use explicit fixtures, never real model credentials.

TLS hostname verification and the ability to customize an HTTP dial are provided
by the [Go Transport contract](https://pkg.go.dev/net/http#Transport); the service
owns its policy decision and must not rely on Go's URL syntax check as an address
authorization check.
