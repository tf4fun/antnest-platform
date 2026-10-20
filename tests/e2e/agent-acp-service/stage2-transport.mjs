import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  context,
  propagation,
  trace,
  SpanKind,
} from "../../../services/agent-acp-service/node_modules/@opentelemetry/api/build/src/index.js";
import { NodeSDK } from "../../../services/agent-acp-service/node_modules/@opentelemetry/sdk-node/build/src/index.js";
import { OTLPTraceExporter } from "../../../services/agent-acp-service/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/index.js";
import { FixtureCallerContext } from "../../support/fixture-caller-context.mjs";

let fixtureAuthentication;
let fixtureOrigins;
let administratorID;
export function configureStage2Authentication(origins) {
  fixtureOrigins = origins;
  fixtureAuthentication = new FixtureCallerContext(
    process.env.ANTNEST_SERVICE_AUTH_DIRECTORY,
    process.env.ANTNEST_IDENTITY_CCT_SIGNING_KID,
  );
}
export function registerFixturePrincipal(principal, sessionID) {
  if (!fixtureAuthentication) return;
  fixtureAuthentication.register(principal, sessionID);
  administratorID ??= principal.user_id;
}
function authenticatedHeaders(url, headers, body) {
  if (!fixtureAuthentication) return headers;
  const address = new URL(url);
  const receiver = Object.entries(fixtureOrigins).find(
    ([, origin]) => new URL(origin).host === address.host,
  )?.[0];
  if (!receiver) return headers;
  const extra = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !name.startsWith("x-antnest-fixture-"),
    ),
  );
  if (headers["x-antnest-fixture-authentication"] === "none") return extra;
  const login =
    receiver === "identity-service" &&
    address.pathname.endsWith("/local-login");
  const caller =
    receiver === "agent-acp-service"
      ? /(?:execution-audit|execution-events)/u.test(address.pathname)
        ? "admin-console"
        : "edge-gateway"
      : login
        ? "edge-gateway"
        : "admin-console";
  return {
    ...extra,
    ...fixtureAuthentication.headers({
      caller,
      receiver,
      ...(login
        ? {}
        : {
            principalID:
              headers["x-antnest-user-id"] ??
              headers["x-antnest-principal-id"] ??
              administratorID,
            organizationID:
              headers["x-antnest-organization-id"] ??
              body?.organization_id ??
              address.searchParams.get("organization_id") ??
              undefined,
            agentID:
              headers["x-antnest-agent-id"] ??
              (receiver === "agent-controller"
                ? /^\/internal\/agents\/([^/]+)/u.exec(address.pathname)?.[1]
                : undefined),
          }),
    }),
  };
}

export async function waitFor(read, accept, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}

export function startClientTelemetry(endpoint) {
  const sdk = new NodeSDK({
    serviceName: "antnest-stage2-client",
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [],
  });
  sdk.start();
  return sdk;
}

export function traced(name, operation) {
  return trace
    .getTracer("antnest-stage2-client")
    .startActiveSpan(name, async (span) => {
      try {
        return await operation(span.spanContext().traceId);
      } finally {
        span.end();
      }
    });
}

export async function json(
  url,
  body,
  status = 200,
  headers = {},
  method = body === undefined ? "GET" : "POST",
) {
  return trace.getTracer("antnest-stage2-client").startActiveSpan(
    `HTTP ${method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "server.address": new URL(url).hostname,
      },
    },
    async (span) => {
      const outgoing = {
        "content-type": "application/json",
        ...authenticatedHeaders(url, headers, body),
      };
      propagation.inject(context.active(), outgoing);
      try {
        const response = await fetch(url, {
          method,
          headers: outgoing,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        span.setAttribute("http.response.status_code", response.status);
        const payload = await response.json();
        assert.equal(
          response.status,
          status,
          `${method} ${new URL(url).pathname}: ${JSON.stringify(payload)}`,
        );
        return payload;
      } finally {
        span.end();
      }
    },
  );
}
