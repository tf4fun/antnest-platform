# Agent UI Operations

## Deployment topology

Exactly one Agent UI replica serves a deployment. The Node process holds the
owner registry, permission inbox, Session caches and operation journals in one
process, so a second replica would split pending work that only the owning
process can settle. The Edge Gateway points at a single upstream through
`ANTNEST_AGENT_UI_URL`; owner-sticky routing across multiple replicas is not
implemented and there is no `ANTNEST_AGENT_UI_URLS` setting. Rolling two
replicas is not seamless and is unsupported.

## Load balancer and idle buffering

Observation uses Server-Sent Events with a 15 second heartbeat comment; an LB
idle timeout must tolerate that interval. The Agent UI's ACP transport is
HTTP/SSE, not WebSocket — do not configure or claim a ping interval for it.
The ACP service's public and owner-peer WebSocket heartbeat is configured
independently on that service and does not apply to the Agent UI path.

## Restart and recovery

Restart loses all volatile state: SSE journals, view pagers, the permission
inbox, in-flight operations and cached Agent views. Rehydration reads
authoritative state from ACP and reissues still-pending permission requests;
no prompt or permission decision is replayed from volatile memory. Old inbox
entries disappear with the old process; only still-pending requests reissued
by ACP populate the new inbox. While connected, SDK cancellation or a matching
resolution notice withdraws a pending entry without selecting an answer.

See [architecture](architecture.md) for the ownership model and the
[service README](../README.md) for configuration.
