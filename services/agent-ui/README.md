# Agent UI

Agent UI is Antnest Platform's end-user conversation workspace. It presents
Agents, Sessions, messages, tool activity, and attachments without owning Agent
execution or exposing internal service credentials to the browser.

## Status

Implemented for the Stage 3 Agent workspace. Edge Gateway serves the application
at `/workspace/`, returns an authoritative browser-safe Agent bootstrap, and
admits same-origin ACP v1 WebSockets without exposing internal credentials.

## Owns

- page-local navigation, selection, composer, attachment, and disclosure state;
- end-user presentation of ACP messages, attachments, and tool activity;
- server-advertised Session model/mode selection and configuration notifications;
- current context usage and cumulative known Session cost from ACP notifications;
- exact Tool approval requests, once/Session decisions, cancellation and reissued
  requests after reconnect; no approval is stored as a user message;
- connection, unavailable, cancellation, and retry feedback in the browser;
- leased, authenticated Agent-state observation and read-only reconnection;
- account exit, administrator application switching, and usable no-Agent states;
- the `Antnest / Workspace` implementation of the shared design language.

## Does Not Own

- users, browser sessions, Agent access policy, or credentials;
- Agent configuration authority, Run admission, Runtime endpoints, or MCP dispatch;
- ACP Session or message persistence;
- any PostgreSQL schema or direct internal-service connection.

## Production Boundary

The browser talks only to Edge Gateway on the same origin. Edge Gateway must:

1. resolve the browser session through Identity Service;
2. return only Agents the principal may use;
3. proxy ACP WebSockets while injecting the opaque Agent access subject on the
   server side;
4. never return that subject or an internal Runtime endpoint to JavaScript.

The browser contract is
[`../../contracts/edge-gateway/session-contract.json`](../../contracts/edge-gateway/session-contract.json).
Agent UI uses the official ACP TypeScript SDK behind one adapter boundary so
transport behavior does not reshape its presentation model.

The client owns the immediate display of a submitted user prompt. ACP owns the
authoritative replay: loading a Session builds a replacement projection while
keeping the cached transcript readable. Only a successful replay replaces that
transcript; failed replay retains it. Same-connection prompt and replay do not
overlap for one Session.
Stop remains bound to the outstanding prompt or the authenticated snapshot's
active Session even when another conversation is selected. Completion obtains
a fresh state subscription; Refresh workspace reloads access and reconnects
without resending a prompt. See [Workspace state](docs/workspace-state.md) and the
[recovery contract](docs/architecture.md#conversation-recovery-and-cancellation)
for the service boundaries. Cross-connection Docker integration has passed;
remaining interactive browser work is tracked in
[C4 closeout](../../docs/docker-single-node-closeout.md).
Native WAV/MP3, PDF and UTF-8 documents follow the negotiated ACP input contract;
images and audio have bounded inline history presentation. See
[multimodal input](docs/multimodal-input.md) for file limits, lifecycle and
service-versus-deployment verification boundaries.
See [Session usage](docs/session-usage.md) for unknown-versus-zero cost, replay,
freshness and Agent/session isolation. The UI does not calculate a bill or use
model prices; it replaces the server's cumulative snapshot.

## Local Development

```sh
cd services/agent-ui/web
npm ci
npm run dev -- --port 5174
```

Open `http://127.0.0.1:5174/workspace/?preview=1` for the development-only
fixture. Without `preview=1`, the application exercises the same-origin
production adapter and requires Edge Gateway.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

See [architecture](docs/architecture.md) and the platform
[design language](../../docs/design-language.md).

F06 uses the [deployed permission profile](../../scripts/acp-permissions/README.md).
Pure tests cover approval inbox cleanup, stale replies, configuration response
ordering and disabled submission during configuration. Browser acceptance through
Gateway verifies allow once, reject once, Chat mode, completion unlocking, default
collapsed Tool details and mobile wrapping; it supplements, not replaces, tests.
