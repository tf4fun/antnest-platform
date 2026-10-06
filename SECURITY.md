# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/tf4fun/antnest-platform/security/advisories/new).
Include the affected component, version or commit, reproduction steps, and the
impact you observed. We aim to acknowledge reports within five working days and
will coordinate a fix and disclosure date with you.

## Supported versions

The project has not published a stable release yet. Security fixes are made on
the `main` branch and included in the next tagged release.

## Deployment security model

Antnest Platform is designed for a single trusted Docker host or a private
cluster network. Before exposing a deployment, understand these boundaries:

- **Edge Gateway is the only public entry point.** All other services expose
  internal HTTP/JSON RPC. Identity, Gateway, Console, Agent UI, Controller, ACP,
  RC, Registry and native Runtime have passed their owning-service authentication
  gates. Egress has also passed its owning-service authentication gates;
  Compose now wires private credentials and purpose networks; actual deployment
  and complete token/HTTP cross-service integration have passed in
  the rollout ledger. Services must stay on private networks that browsers, Agent
  Runtimes and the Internet cannot reach.
- **Runtime Controller has Docker access.** By default it talks to
  `unix:///var/run/docker.sock`, which is equivalent to root on the host. Its
  revision 17 control boundary admits only verified Controller workloads and
  enforces an operator image repository/digest policy before new Docker effects.
  Control uses an explicit purpose-network IP and readiness a separate loopback
  listener. These limits do not contain a compromised RC process. A useful
  socket proxy needs resource-scope, create-payload and archive-target checks;
  broad method/path filtering alone is insufficient. See the
  [RC assessment](services/runtime-controller/api/service-authentication.md#docker-socket-assessment).
  RC-issued Runtime instance credentials, native admission and private Controller
  to ACP relay are implemented. Compose uses separate control and management
  interfaces; real native Runtime, MCP, learning and rebuild acceptance has passed.
- **Runtime Egress is privileged.** It owns a TUN device, routes and nftables
  rules. Its control listener admits only authenticated Controller calls on its
  configured purpose address; readiness uses a separate loopback listener.
  These checks do not contain a compromised Egress process.
- **Agent Runtimes execute untrusted, model-selected commands.** They run as an
  unprivileged executor user, and their network traffic is forced through
  Runtime Egress policy. Do not mount host paths or secrets into Runtimes.
- **Managed MCP credentials have a separate boundary (#37).** Controller stores
  write-only values encrypted with location-bound AAD; Template reads expose only
  set/fingerprint metadata. Only authenticated RC resolves the frozen revision.
  Its generation-private bootstrap is root-owned 0700/0400 and mounted read-only,
  outside workspace backups. Dedicated server UIDs 2000..2007 block UID 1000 tool
  reads of their environ, memory, descriptors and ptrace. Each server receives
  only its own secrets. MCP code is trusted: it can disclose its own credentials,
  and mutable workspace executables/dependencies can undermine this boundary.
  Use administrator-controlled image or read-only preset code for credentialed
  servers. Host/Docker administrators remain trusted. See the
  [shared contract](contracts/runtime/managed-mcp-secrets.md).
- **The network cutover has one OTLP infrastructure exception.** A bounded
  ingestion-only transport preserves Runtime telemetry while moving Jaeger
  entirely off management. It has no business credentials, query/control API or
  arbitrary destination. Actual Compose deployment and authorization probes on
  all 24 created networks have passed. See the
  [deployment network contract](contracts/platform/development-networks.md#runtime-telemetry-exception).
- **TLS is not terminated by the platform.** Put a TLS-terminating reverse proxy
  in front of Edge Gateway and keep `ANTNEST_EDGE_COOKIE_SECURE=true`.
- **RPC content capture can record secrets.** Keep
  `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` outside local debugging.
- **Host diagnostics require an explicit overlay.** Base Compose publishes
  only Gateway. `compose.debug.yaml` is for disposable local diagnostics and
  enables an opaque credential-free relay and binds every publication to
  loopback, preserving receiver workload/CCT verification.
  Keep it out of public deployments; see the
  [development port contract](contracts/platform/development-authentication.md#host-ports-and-explicit-diagnostics).

## Required private secrets and startup rejection

`.env.example` leaves database/bootstrap passwords and encryption keys empty;
The deployment requires each with no public fallback. Controller/Identity
validate their single-key or ring choice before opening listeners or starting
dependency clients; Compose forwards those optional fields unchanged. Other
secrets keep their Compose required-value checks. For a fresh deployment,
run `scripts/generate-dev-env.sh` to create independent random values in a
mode-0600 `.env`. Existing output is refused unless `--force` is explicit. That
option is for disposable data and does not rotate existing roles or encrypted data.

Identity, Controller, RC, Registry, ACP and Egress reject the formerly published
database passwords using their driver's PostgreSQL parser. Identity, Controller
and ACP also reject 32-byte encryption keys containing a single repeated byte.
Identity rejects the published administrator password only when creating a new
bootstrap account; existing accounts are not rejected or reset by an unused value.
Errors and opt-in warnings name variables without including credentials.

Only exact `ANTNEST_ALLOW_PUBLIC_DEV_SECRETS=true` permits these fixed values for
explicit disposable tests, with one startup WARN per affected variable. Other
spellings/whitespace are rejected. The standard Compose files never pass this
flag; fixed-fixture E2E uses its own explicit override. It does not restore removed
bearers, enable private Provider access or enable Skill learning debug mode.
See the [secret admission contract](contracts/platform/development-secrets.md).

Keep workload credentials in the private directory prepared by
`scripts/dev-service-tokens.mjs`; Registry's retired API/source tokens remain
rejected, including with the development opt-in. Never commit either generated
configuration. Controller and Identity now use authenticated envelopes with an
active master key and decrypt-only ring entries. Their independent `rekey`
commands rotate stored Provider/managed MCP credentials and OIDC session secrets online (#42, #37).
Every ring member passes the same admission policy, and unknown or relabeled
keys fail authentication. See [Rotating encryption keys](docs/encryption-key-rotation.md)
for the coordinated initial binary upgrade, add/activate/rekey/retire order,
zero-remaining checks and backups. Preserve retired keys with historical backups;
rekey neither revokes leaked external credentials nor rewrites backup copies.
The shared KMS interface is available; external adapters are follow-up work.

## Service authentication rollout

The [platform authentication contract](contracts/platform/service-authentication.md)
defines workload mTLS (or explicit per-caller interim tokens), Identity-signed
Caller Context Tokens, per-route allowlists and JSON media-type checks. Its
[trust model](docs/architecture/trust-model.md) and
[rollout ledger](contracts/platform/service-authentication-rollout.json) distinguish
the admitted service batches from deployment and integration acceptance.
The completed integration uses the explicit disposable-development token/HTTP
profile, synthetic model responses and fresh private per-pair credentials.
`make e2e-service-authentication-integration` verifies actual network boundaries,
issuer signatures, audience/scope and caller-role rejection, native Runtime and
normal browser/lifecycle/Skill workflows. Private bridges require Docker Engine
28+ and `gateway_mode_ipv4=isolated`; recreate an existing deployment's networks
with its normal stop/start procedure before adopting that option.
Owning-service TLS/mTLS gates have passed; full-platform mTLS deployment is not
claimed. Docker-socket containment (#35), long-lived stream renewal (#58) and
service-principal delegation (#77) remain independent work in
[#80](https://github.com/tf4fun/antnest-platform/issues/80).
