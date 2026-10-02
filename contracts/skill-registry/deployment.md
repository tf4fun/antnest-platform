# Skill learning and discovery deployment wiring

This document defines how the standard Compose deployment wires the Skill
learning, source, discovery and temporary-package contracts. It introduces no
service API; the [operator guide](../../docs/skill-deployment.md) covers
configuration in practice.

The standard `compose.yaml` plus `compose.stage3.yaml` configure the complete
Skill propagation workflow, without test-only overrides for authentication or
maintenance. Features remain explicitly opt-in through operator-owned values:

- ACP receives `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID` and
  `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY` unchanged. A configured signing key
  connects its existing learning policy reader to `http://agent-controller:8080`.
- RC receives `ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS` unchanged and freezes
  the public verifier set into newly created/rebuilt Runtimes. The private key
  is never passed to RC, Runtime, Registry or either frontend.
- `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN` is one shared source-reader setting.
  When nonempty, Compose sets ACP's Registry origin to `http://skill-registry:8080`,
  its Registry bearer to the existing `ANTNEST_SKILL_REGISTRY_API_TOKEN`, and its
  source bearer to this token. Registry's source origin becomes
  `http://agent-acp-service:8080`, using the same source bearer.
- When the source token is absent or empty, both source origins and ACP's three
  discovery settings are empty. Formal hosting/template delivery continues to
  use the Registry API token; its presence alone never enables discovery.
- Service validators remain authoritative for key encoding, key IDs, verifier
  structure and distinct printable bearers of at least 32 bytes. Partial or
  malformed opt-in configuration must fail existing startup validation; Compose
  does not silently supply signing keys or invent an authentication fallback.

Signing and verifier key IDs follow the exact `maintenanceKid` definition in
[RuntimeSpec](../runtime/runtime-spec.schema.json#/$defs/maintenanceKid):
1–64 ASCII letters, digits, `_` or `-`, starting with a letter or digit,
without dots or whitespace normalization. All four validators use the
[shared key ID fixtures](../runtime/maintenance-kid-fixtures.json).

Registry stays outside Runtime management and Egress networks and exposes no
host port. The `compose.stage3.yaml` override removes ACP's direct host port. Agent UI receives
neither source bearer nor signing material; the browser still uses Gateway and
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

`make test-skill-deployment` runs the Compose contract tests, and
`make e2e-skill-deployment` runs a disposable Docker workflow using these
standard environment names and production configuration. Its test overlays may
choose isolated images, network ranges and a local model, but may not replace
source/learning authentication environment wiring.
