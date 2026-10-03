# Controller authentication acceptance

Run serially from the repository root with NVM Node:

```sh
node tests/e2e/service-authentication/controller/run.mjs
```

The harness builds the real Controller image, uses isolated official PostgreSQL
and Temporal, and generates private CSPRNG service credentials and an Ed25519
Identity fixture. Dependency doubles reject missing credentials and untrusted
user headers. Checks cover native admission, signed scope, strict JSON, catalog
writes, unchanged Registry CCT, ACP control publication, custom-port health,
startup rejection, normal SIGTERM/SIGINT and restart. The separate Go component
gate exercises all five concrete dependency clients, including Egress and token
rotation. These owning-service checks do not claim cross-service acceptance.

The project, volumes, networks and private credentials are cleaned in finally;
only bounded results and redacted failure diagnostics remain under ignored
artifacts/verification/.
No real Provider credentials or model inference are used.

Provider checks also exercise production creation, saved/draft model-only
discovery, `/access` removal, Identity/private/metadata denial, bounded DNS errors,
disabled redirects and metadata normalization. A separate internal Docker network
uses a randomly selected public-classified subnet for the Provider fixture, so the
production private-endpoint opt-in remains disabled and no Internet traffic is
needed. Creation must send no Provider request; discovery sends only the synthetic
Provider credential. Native Go tests separately verify mixed DNS, rebinding, IP
pinning, original TLS/SNI/Host and ignored environment proxies.
