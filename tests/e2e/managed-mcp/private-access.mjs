import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceClient } from "../../support/service-grants.mjs";
import { readPrivateExecutionState } from "../../support/private-acp-execution-state.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import { openStage3Connection } from "../stage3-base/connection.mjs";

function loopback(value, path = "/") {
  assert.equal(typeof value, "string", "Managed private endpoint required");
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      url.pathname === path &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "Managed private endpoint must use the owned loopback relay",
  );
  return path === "/" ? url.origin : url.href;
}

// The active runner stays on the host to retain its real Docker peer checks.
// Container compatibility uses the same grants on the receivers' private nets.
export function createManagedPrivateAccess({
  env = process.env,
  secrets,
  preserveConnection,
  signal,
}) {
  assert(Array.isArray(secrets));
  assert.equal(typeof preserveConnection, "function");
  const host = Boolean(env.TEST_DOCKER_PROJECT);
  const acp = host
    ? loopback(env.TEST_ACP_ORIGIN)
    : "http://agent-acp-service:8080";
  const identity = host
    ? loopback(env.TEST_IDENTITY_ORIGIN)
    : "http://identity-service:8080";
  const otlp = host
    ? loopback(env.TEST_OTLP_ENDPOINT, "/v1/traces")
    : "http://jaeger:4318/v1/traces";
  if (host)
    assert(
      typeof env.TEST_MANAGED_CREDENTIAL_DIRECTORY === "string" &&
        env.TEST_MANAGED_CREDENTIAL_DIRECTORY.startsWith("/"),
      "Managed credential directory required",
    );
  const paths = {
    "gateway-identity": ["edge-gateway", "tokens", "identity-service"],
    "agent-ui-acp": ["agent-ui", "tokens", "agent-acp-service"],
  };
  const service = serviceClient({
    identityEndpoint: identity,
    readCredential(grant) {
      assert(
        Object.hasOwn(paths, grant),
        "Managed private grant is not allowed",
      );
      return readFileSync(
        host
          ? join(env.TEST_MANAGED_CREDENTIAL_DIRECTORY, ...paths[grant])
          : `/run/auth/${grant}`,
        "utf8",
      );
    },
  });
  const telemetry = createPrivateACPTelemetry(otlp);
  let index = 0;
  return {
    telemetry,
    open(profile, agentId, browser, principal) {
      const connection = ++index;
      assert(!profile.http, "Managed MCP uses its original WebSocket profiles");
      // This recorder owns immutable wire receipts, one initialize and joined
      // close. Managed owns its additional busy outcome and business labels.
      return openStage3Connection(
        { ...profile, name: `${profile.name}:connection-${connection}` },
        agentId,
        browser,
        {
          principal,
          service,
          telemetry,
          secrets,
          signal,
          endpoint: `${acp}/v${profile.version}/acp`,
          preserve: (snapshot) => preserveConnection(connection, snapshot),
        },
      );
    },
    state(agentId, browser, principal, receipts) {
      return readPrivateExecutionState(agentId, browser, {
        principal,
        service,
        secrets,
        signal,
        receipts,
        endpoint: acp + "/rpc/agent-acp/get-agent-execution-state",
      });
    },
  };
}
