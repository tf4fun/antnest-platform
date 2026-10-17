import { commandFixture } from "../acp-commands/connection.fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";

const { openPrivateCommandConnection } =
  await import("../acp-commands/connection.mjs");

// Actual SDK/TCP produces the original local receipt. Controlled raw spans
// exercise correlation only; they do not prove production cancellation.
export async function notificationTraceFixture(t, version = 1) {
  const profile = { name: `v${version}-ws`, version, transport: "websocket" };
  const peer = await commandFixture(t, profile);
  const client = peer.register(
    await openPrivateCommandConnection(profile, "agent", peer.browser, {
      ...peer.options,
      captureNotifications: true,
    }),
  );
  await client.notify("cancel", { sessionId: "session" });
  await client.closeAndWait();
  const receipt = client.lastNotification;
  const f = privateBoundaryFixture(undefined, { version });
  const connection = f.connectionTrace;
  connection.traceID = receipt.connectionTraceID;
  connection.spans[0].spanID = receipt.clientSpanID;
  for (const span of connection.spans) {
    span.traceID = connection.traceID;
    for (const ref of span.references) {
      ref.traceID = connection.traceID;
      ref.spanID = receipt.clientSpanID;
    }
  }
  const root = f.request;
  f.trace.spans = [root];
  root.operationName = "acp session/cancel";
  root.references[0].traceID = connection.traceID;
  root.tags = root.tags.filter(({ key }) => key !== "antnest.request.id");
  for (const [key, value] of Object.entries({
    "span.kind": "internal",
    "rpc.method": "session/cancel",
    "antnest.agent.id": receipt.agentId,
    "antnest.session.id": receipt.sessionId,
  }))
    f.field(root, key, value);
  return { ...f, connection, root, receipt, client };
}
