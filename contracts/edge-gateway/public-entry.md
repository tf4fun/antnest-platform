# Gateway public entry

The Gateway owns the browser-facing origin, transport and client-address trust
boundary. Internal service authentication remains independent; the public TLS
certificate is never used as an internal workload credential.

## Configuration and admission

- `ANTNEST_EDGE_PUBLIC_ORIGIN` is a single absolute origin (scheme, host and
  optional port only), without credentials, path, query or fragment. HTTPS is
  required except for an explicit HTTP origin with a literal loopback IP.
  It is mandatory whenever the listener is not a literal loopback address.
- `ANTNEST_EDGE_TLS_CERT_FILE` and `ANTNEST_EDGE_TLS_KEY_FILE` must be configured
  together. Native TLS requires a matching HTTPS public origin and supports
  TLS 1.2 or newer. An unreadable or invalid initial pair prevents startup.
- `ANTNEST_EDGE_TLS_CA_FILE` optionally adds a private CA to the native-TLS
  health probe's system trust roots. Keep this trust bundle stable across leaf
  certificate rotation; the probe does not read the replaceable leaf files.
- `ANTNEST_EDGE_TRUSTED_PROXIES` is an explicit comma-separated CIDR allowlist;
  empty trusts no proxy. An HTTPS origin on a plain HTTP listener requires this
  allowlist. Only the reference proxy can reach that listener in this topology.
- `ANTNEST_EDGE_COOKIE_SECURE` defaults to `true`. Setting it to `false` is
  accepted only on a literal loopback HTTP listener and produces a startup
  warning. Native TLS and HTTPS proxy deployments always use Secure cookies.
- The development Compose listener is container-private, with a host port
  published only on `127.0.0.1`. It sets an explicit loopback HTTP public origin
  and keeps Secure cookies. Chromium accepts Secure cookies for loopback HTTP;
  other deployment hosts must use HTTPS. The declared origin is not a substitute
  for network isolation or host-port binding.

## Request boundary

Configuration normalizes host case, IP notation and default ports to a browser
origin; internationalized domain names use ASCII punycode. Existing Origin
checks compare one nonempty Origin header exactly with the configured
public origin, independently of the inbound Host and forwarded scheme. Only
direct loopback HTTP without a configured origin derives its expected origin
from the request. This contract does not broaden which routes require Origin;
mandatory Origin admission and session-bound CSRF are separate deliveries.

The immediate TCP peer is the client address unless it belongs to a trusted
proxy CIDR. For trusted peers, parse `X-Forwarded-For` right to left, skipping
trusted proxies and selecting the first untrusted IP. Ignore entries left of
that boundary. Missing, malformed or all-trusted chains fall back to the
immediate peer. IPv4-mapped IPv6 addresses are normalized; zone identifiers and
hostnames are not accepted as forwarded client addresses. `Forwarded` and
`X-Real-IP` are never trusted.

Use this computed client address for login source admission and request
diagnostics. Downstream requests discard all incoming `X-Forwarded-*`,
`Forwarded` and `X-Real-IP`, then receive exactly one `X-Forwarded-For`,
`X-Forwarded-Host` and `X-Forwarded-Proto`, derived from the computed address
and configured public origin. They never carry the caller's claimed chain.

HTTPS public origins emit `Strict-Transport-Security: max-age=31536000` on
Gateway responses, including errors and WebSocket handshakes. Subdomains and
preload are not implicitly included.

## Certificate rotation and health

Replace the certificate and key files, then send `SIGHUP` to Gateway. It loads
and validates both files before atomically publishing the new pair. Existing
HTTP and WebSocket connections stay open. A failed reload retains the last
valid pair and emits a bounded error classification without key material.

`--healthcheck` probes the actual local listener, using HTTPS in native TLS
mode. It verifies the serving certificate against stable trust roots and the
public hostname rather than disabling TLS verification. A rejected leaf-file
replacement leaves the last valid serving certificate healthy. Proxy-mode
health probes the internal HTTP listener;
external HTTPS readiness is verified separately through the proxy.

## Delivery and evidence

1. Gateway unit/contract tests cover unsafe startup, exact origin comparison,
   proxy spoofing, malformed address chains, forwarding headers and HSTS.
2. A real native-TLS listener test rotates certificates with an active WebSocket,
   retains the old certificate after an invalid replacement and verifies health.
3. Compose examples cover native TLS and the reference TLS proxy. Docker/browser
   acceptance covers actual login cookies, Console, Workspace, ACP WebSocket and
   separate source limits for two clients behind the same proxy.

The consumer fixtures select this public origin even when their transport uses
the private Gateway address. The `gateway-tls` CI suite executes step 3 with the
reference proxy and verifies cleanup of its disposable environment. See
[#57](https://github.com/tf4fun/antnest-platform/issues/57); broader Origin,
cookie/CSRF and login-account policy changes remain in #10, #62 and #2.
