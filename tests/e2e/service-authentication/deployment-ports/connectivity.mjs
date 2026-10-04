import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(
  new URL(
    "../../../../services/agent-acp-service/package.json",
    import.meta.url,
  ),
);
const { Client: PostgresClient } = require("pg");
const { Client: GRPCClient, credentials } = require("@grpc/grpc-js");

const databaseURL = new URL(process.env.ANTNEST_ACP_TEST_DATABASE_URL);
assert.equal(databaseURL.hostname, "127.0.0.1");
assert.equal(databaseURL.pathname, "/antnest_agent_acp_test");
const database = new PostgresClient({
  connectionString: databaseURL.href,
  connectionTimeoutMillis: 10000,
  query_timeout: 10000,
});
try {
  await database.connect();
  const result = await database.query(
    "SELECT current_database() AS database, current_user AS username",
  );
  assert.deepEqual(result.rows, [
    {
      database: "antnest_agent_acp_test",
      username: "antnest_agent_acp",
    },
  ]);
} finally {
  await database.end();
}

const temporalAddress = process.env.ANTNEST_TEMPORAL_TEST_ADDRESS;
assert.match(temporalAddress, /^127\.0\.0\.1:[1-9][0-9]*$/u);
const temporal = new GRPCClient(temporalAddress, credentials.createInsecure(), {
  "grpc.enable_http_proxy": 0,
});
try {
  for (const [method, request] of [
    ["GetSystemInfo", Buffer.alloc(0)],
    // DescribeNamespaceRequest field 1 is the namespace, verified against the
    // checked Go Temporal API. Only transport reachability is under test here.
    [
      "DescribeNamespace",
      Buffer.concat([Buffer.from([0x0a, 7]), Buffer.from("antnest")]),
    ],
  ]) {
    const result = await new Promise((resolve, reject) => {
      temporal.makeUnaryRequest(
        `/temporal.api.workflowservice.v1.WorkflowService/${method}`,
        (value) => value,
        (value) => value,
        request,
        { deadline: Date.now() + 10000 },
        (error, response) => (error ? reject(error) : resolve(response)),
      );
    });
    assert(Buffer.isBuffer(result) && result.length > 0, `${method} response`);
  }
} finally {
  temporal.close();
}

console.log(
  JSON.stringify({
    checks: 3,
    postgres_query: true,
    temporal_system_info: true,
    temporal_namespace: true,
    host_loopback: true,
  }),
);
