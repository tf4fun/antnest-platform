# Docker Runtime Provider Architecture

## Model

The Provider is deliberately thinner than a controller. Each request contains
the complete generation-bound Runtime specification. Resource names and labels
derive from `agent_id`, generation, and Runtime instance ID, making Ensure
idempotent by observation.

```text
Runtime Controller HTTP client
  -> strict wire DTO validation
  -> Docker driver observes deterministic resource
  -> ensure / stop / remove side effect
  -> three-state DriverResult
```

There is no queue, database, desired state, or retry policy here. Transport loss
after a Docker side effect begins returns `unknown`; Runtime Controller decides
when to observe again.

## Package Map

| Package | Responsibility |
| --- | --- |
| `httpapi` | Internal HTTP routing and strict JSON decoding |
| `protocol` | Provider request/result DTOs and validation |
| `dockerengine` | Docker API client and deterministic resource operations |
| `config` | Listen address and socket configuration |

Adding a Kubernetes implementation means adding another provider service that
implements the same resource semantics. It does not add Kubernetes branches to
this Docker adapter.
