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
- connection, unavailable, cancellation, and retry feedback in the browser;
- account exit, administrator application switching, and usable no-Agent states;
- the `Antnest / Workspace` implementation of the shared design language.

## Does Not Own

- users, browser sessions, Agent access policy, or credentials;
- Agent configuration, Run admission, Runtime endpoints, or MCP dispatch;
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
authoritative replay: reloading a Session clears the local projection before
replaying persisted messages and Tool activity.

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
