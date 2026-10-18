import assert from "node:assert/strict";
import { connectACP } from "./acp-connection.mjs";
import { serviceClient } from "../../support/service-grants.mjs";

// Delegate the existing browser session through the actual Identity service.
// The browser Cookie itself is never sent to the private ACP receiver.
export async function openBrowserPrivateACP(
  version,
  agentId,
  browser,
  {
    principal,
    telemetry,
    secrets,
    service = serviceClient(),
    endpoint = `http://agent-acp-service:8080/v${version}/acp`,
    signal,
    captureRawFrames,
    captureNotifications,
    requestPermission,
    clientCapabilities,
  },
) {
  assert(
    captureRawFrames === undefined || typeof captureRawFrames === "boolean",
    "captureRawFrames must be a boolean",
  );
  assert(
    captureNotifications === undefined ||
      typeof captureNotifications === "boolean",
    "captureNotifications must be a boolean",
  );
  signal?.throwIfAborted();
  assert([1, 2].includes(version), "unsupported private ACP version");
  assert(Array.isArray(secrets), "private evidence canary inventory required");
  const accessToken = browser.accessToken;
  assert(
    typeof accessToken === "string" && accessToken.length > 0,
    "existing browser access token required",
  );
  for (const field of ["organization_id", "user_id"])
    assert(
      typeof principal?.[field] === "string" && principal[field].length > 0,
      "original browser Principal required",
    );
  const issued = await service.workspaceContext(accessToken, agentId, {
    signal,
  });
  signal?.throwIfAborted();
  for (const field of ["organization_id", "user_id"])
    assert(
      issued.principal[field] === principal[field],
      "Identity workspace authority changed",
    );
  const authorization = service.authorization("agent-ui-acp");
  const grant = authorization["Antnest-Service-Authorization"];
  secrets.push(
    accessToken,
    issued.context,
    grant,
    grant.slice("Bearer ".length),
  );
  const client = connectACP(version, agentId, undefined, {
    boundary: "private-acp",
    endpoint,
    context: issued.context,
    authorization,
    telemetry,
    captureRawFrames,
    captureNotifications,
    requestPermission,
    clientCapabilities,
  });
  try {
    const initializationResult = await client.initialize();
    signal?.throwIfAborted();
    client.initializationResult = initializationResult;
    return client;
  } catch (error) {
    await client.closeAndWait();
    signal?.throwIfAborted();
    throw error;
  }
}
