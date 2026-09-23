import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { firstGatewayState, assertV1Completion } from "./stage2-protocol.mjs";

test("state reconnect reads a fresh SSE snapshot and closes each transport", async (t) => {
  let requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.cookie, "antnest_session=test");
    assert.equal(request.headers.traceparent, undefined);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: workspace_state\ndata: ");
    response.write(JSON.stringify({ agent_id: "agent", sequence: ++requests }));
    response.write("\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const sequence of [1, 2])
    assert.deepEqual(
      await firstGatewayState(url, { cookie: "antnest_session=test" }, "agent"),
      {
        agent_id: "agent",
        sequence,
      },
    );
});

test("v1 completion requires a successful Tool update and final response", () => {
  const events = [
    { sessionUpdate: "tool_call", toolCallId: "tool" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Stage 2 Runtime Tool execution completed.",
      },
    },
  ];
  assert.doesNotThrow(() =>
    assertV1Completion({ stopReason: "end_turn" }, events),
  );
  assert.throws(() => assertV1Completion({ stopReason: "cancelled" }, events));
  assert.throws(() =>
    assertV1Completion(
      { stopReason: "end_turn" },
      events.filter((event) => event.sessionUpdate !== "tool_call_update"),
    ),
  );
  assert.throws(() =>
    assertV1Completion({ stopReason: "end_turn" }, events.slice(0, -1)),
  );
});
