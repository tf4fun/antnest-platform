// Exercise the same pinned official SDK and immediate close pattern as ACP.
import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "../../../../services/agent-acp-service/node_modules/@modelcontextprotocol/client/dist/index.mjs";

const [endpoint, executionId, successTrace, failureTrace] =
  process.argv.slice(2);
for (const failed of [false, false, false, true]) {
  const client = new Client(
    { name: "runtime-http-close-e2e", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        "x-antnest-expected-execution-id": executionId,
        traceparent: `00-${failed ? failureTrace : successTrace}-0123456789abcdef-01`,
      },
    },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "read"));
    const result = await client.callTool({
      name: "read",
      arguments: {
        path: {
          root: "workspace",
          path: failed ? "missing-file" : "read-me.txt",
        },
        offset: 0,
        limit: 128,
      },
    });
    assert.equal(result.isError ?? false, failed);
    if (!failed)
      assert.match(JSON.stringify(result), /runtime close regression/);
  } finally {
    await client.close();
  }
}
