# Skill learning and discovery deployment wiring

This document defines how the standard Compose deployment wires the Skill
learning, source, discovery and temporary-package contracts. It introduces no
service API; the [operator guide](../../docs/skill-deployment.md) covers
configuration in practice.

Status: Compose wiring and actual deployment admission have passed;
complete workflow E2E remains pending in the
[rollout ledger](../platform/service-authentication-rollout.json).
Owning-service protocol peers do not accept the complete propagation workflow.
The deployment batch must provide the following operator-owned configuration:

- ACP receives `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID` and
  `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY` unchanged. A configured signing key
  connects its existing learning policy reader to `http://agent-controller:8080`.
- RC receives `ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS` unchanged and freezes
  the public verifier set into newly created/rebuilt Runtimes. The private key
  is never passed to RC, Runtime, Registry or either frontend.
- Discovery requires ACP's `ANTNEST_ACP_SKILL_REGISTRY_URL` and Registry's
  `ANTNEST_SKILL_REGISTRY_SOURCE_URL`. Each direction uses its own per-pair
  workload credential. The ACP source origin is its admitted workspace listener,
  never the Controller-only publication/settlement origin.
- Registry requires `ANTNEST_IDENTITY_URL` for authenticated, pinned JWKS reads.
  Console carries its own Registry workload authority and the unchanged
  Identity-signed organization CCT. Controller/RC/ACP operation routes use the
  exact grants in the [Registry authentication profile](service-authentication.md).
- The shared token/TLS profile is mandatory even when discovery and learning are
  disabled. Token mode mounts read-only receiver hash files and separate outgoing
  sender files; provisioning must use CSPRNG values, never public conformance
  credentials. Explicit internal HTTP opt-in is only for disposable development.
- Nonempty `ANTNEST_SKILL_REGISTRY_API_TOKEN`,
  `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`, `ANTNEST_ACP_SKILL_REGISTRY_TOKEN` or
  `ANTNEST_ACP_SKILL_SOURCE_TOKEN` fails the corresponding service startup.
- Service validators remain authoritative for exact authentication settings,
  key encoding, key IDs and verifier structure. Partial or malformed configuration
  must fail startup; Compose must not invent a credential fallback.

Signing and verifier key IDs follow the exact `maintenanceKid` definition in
[RuntimeSpec](../runtime/runtime-spec.schema.json#/$defs/maintenanceKid):
1–64 ASCII letters, digits, `_` or `-`, starting with a letter or digit,
without dots or whitespace normalization. All four validators use the
[shared key ID fixtures](../runtime/maintenance-kid-fixtures.json).

Registry stays outside Runtime management and Egress networks and exposes no
host port. ACP has no direct host publication; explicit debug relays only its
authenticated workspace listener. Agent UI receives
neither Registry/source sender credentials nor signing material; the browser still uses Gateway and
the existing Node Bridge HTTP/SSE path.

An existing Runtime does not acquire verifier keys from an RC environment change.
Use a stable current/next public set and the existing explicit rebuild process,
following the [learning key contract](../skill-learning/learning-api.md).
Compose never generates keys implicitly.

Compose passes Registry's
`OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, and trace-specific endpoint/protocol variables.
`OTEL_SERVICE_NAME` is `skill-registry`; default export remains disabled like the
other services. No token, signer, public port or network change accompanies this
HTTP Trace wiring. Registry's span behavior is defined in the
[Trace boundary contract](trace-boundaries.md).

`make e2e-skill-discovery-registry` admits only Registry, using temporary CSPRNG
files, signed Console context and explicit Identity/source protocol peers.
`make test-skill-deployment` covers credential, key/source and network configuration.
`make e2e-skill-deployment` still needs its integration fixtures updated.
Final integration must use actual services, the standard
environment names and production credential/network wiring. Test overlays may
choose isolated images, ranges and a local model, but may not bypass admission.
