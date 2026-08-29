# Docker Runtime Provider

Docker Runtime Provider is a stateless adapter from the Antnest Runtime resource
contract to Docker Engine containers and volumes.

## Responsibilities

- Ensure one deterministic Runtime container for an Agent generation.
- Stop or remove that container.
- Create, retain, or purge the Agent workspace volume as requested.
- Inject Controller/Egress bootstrap endpoints and generation credentials.
- Report external effects as `completed`, `not_started`, or `unknown`.

## Non-Responsibilities

- It does not decide desired state, generation changes, retries, or lifecycle.
- It owns no database and performs no reconciliation loop.
- It does not own TUN, DNS, egress policy, Runtime admission, or Agent work.
- It exposes no public API and trusts only the internal control network.

## Interface

The internal HTTP contract at `:8082` is defined by
[`../../contracts/openapi/runtime-provider-docker-v1.yaml`](../../contracts/openapi/runtime-provider-docker-v1.yaml).
The Docker socket is the only privileged host resource mounted into this
service.

## Development

```bash
cd services/runtime-provider-docker
go test ./...
go vet ./...
```

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/operations.md`](docs/operations.md).
