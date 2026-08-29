# Antnest Platform Contracts

This directory is the language-neutral boundary between independently
deployable components. It contains wire contracts, not generated application
models and not shared business implementation.

## Contract Inventory

| Contract | Consumers | Purpose |
| --- | --- | --- |
| [`openapi/runtime-controller-v1.yaml`](openapi/runtime-controller-v1.yaml) | Future Agent Controller, operators, tests | Trusted-network Runtime lifecycle and Work API |
| [`openapi/runtime-egress-v1.yaml`](openapi/runtime-egress-v1.yaml) | Runtime Controller | Egress reservation lifecycle |
| [`openapi/runtime-provider-docker-v1.yaml`](openapi/runtime-provider-docker-v1.yaml) | Runtime Controller | Stateless Docker Runtime effects |
| [`runtime/contract.json`](runtime/contract.json) | Future Agent Controller, Runtime Egress, and Rust Runtime | RuntimeSpec pointer, status, execution primitives, and packet tunnel |
| [`runtime/runtime-spec.schema.json`](runtime/runtime-spec.schema.json) | Runtime Provider, Controller, and Rust Runtime | Immutable Runtime creation input |

## Ownership Rules

1. The Runtime Controller owns the HTTP API semantics. OpenAPI is the canonical
   external description of that internal service boundary.
2. Runtime peers jointly implement `runtime/contract.json`; neither side may
   add an undocumented wire-only field. The service-boundary rewrite updates
   all peers atomically and carries no legacy Runtime compatibility layer.
3. Service-private persistence models do not belong here.
4. Generated code, when introduced, must be reproducible and must not become a
   second manually maintained schema.
5. Breaking changes require a new contract version. Additive optional fields
   may remain in the current version only when old peers can safely ignore
   them.

The APIs are internal and trust their deployment network. That is a deployment
boundary, not permission to leave request semantics undefined: idempotency,
generation fencing, effect outcomes, and error codes remain part of the
contract.

## Validation

The Go and Rust protocol tests validate their respective encoders and
decoders. Stage 1 E2E validates the complete path through HTTP, Controller,
Runtime transport, and Runtime side effects:

```bash
make test
make e2e-stage1
```
