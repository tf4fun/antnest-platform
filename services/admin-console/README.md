# Admin Console

Admin Console is the administrator React application and thin BFF for Antnest
Platform. It presents Identity and Agent lifecycle facts without becoming a
second source of truth.

## Status

Implemented for Stage 3A. The canonical workflow is
[`../../docs/stage-3-admin-control-plane.md`](../../docs/stage-3-admin-control-plane.md).

## Owns

- React/shadcn administrator UI and page-local state;
- page-oriented request shaping and response aggregation;
- explicit browser DTO allowlists that keep control-plane fields internal;
- organization scoping from Edge Gateway's trusted principal;
- static application delivery and lifecycle event forwarding.

The overview executes its independent reads concurrently under one deadline.
Agent inventory is required; directory and catalog sections degrade with named
status envelopes instead of erasing unrelated data.

## Does Not Own

- browser login, external authorization, or session cookies;
- Identity, ModelProfile, Template, Agent, operation, event, or Runtime records;
- Provider secret retrieval;
- any PostgreSQL schema.

## Dependencies

- Edge Gateway as the only external caller;
- Identity Service for the organization directory;
- Agent Controller for catalog, Agent lifecycle, projections, and events;
- OTLP collector when observability is enabled.

## Interfaces

See [`../../contracts/admin-console/admin-contract.json`](../../contracts/admin-console/admin-contract.json).

## Local Verification

```sh
go test ./...
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
golangci-lint run ./...
```

See [architecture](docs/architecture.md) and [operations](docs/operations.md).
