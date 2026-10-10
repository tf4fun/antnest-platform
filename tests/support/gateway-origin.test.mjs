import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayClient } from "../e2e/identity-closeout/support.mjs";
import { dockerInvocation } from "../e2e/acp-closeout/docker.mjs";
import { gatewayOrigin } from "./gateway-origin.mjs";
import { fixtureEnvironment } from "./authenticated-e2e.mjs";

test("fresh disposable deployments cannot inherit a stale test public origin", () => {
  const env = fixtureEnvironment(
    { TEST_GATEWAY_PUBLIC_URL: "https://stale.example" },
    { project: "antnest-lifecycle-1234abcd", octet: 57 },
  );
  env.ANTNEST_EDGE_PUBLIC_BASE_URL = "http://127.0.0.1:43110";
  assert.equal(
    gatewayOrigin("http://edge-gateway:8080", env),
    env.ANTNEST_EDGE_PUBLIC_BASE_URL,
  );
});

test("only the exact private Gateway DNS name uses the selected deployment origin", () => {
  const env = {
    TEST_GATEWAY_PUBLIC_URL: "https://antnest.example:8443",
    ANTNEST_EDGE_PUBLIC_BASE_URL: "http://127.0.0.1:43110",
  };
  assert.equal(
    gatewayOrigin("http://edge-gateway:8080", env),
    env.TEST_GATEWAY_PUBLIC_URL,
  );
  assert.equal(
    gatewayOrigin("http://edge-gateway:8080", {
      ANTNEST_EDGE_PUBLIC_BASE_URL: env.ANTNEST_EDGE_PUBLIC_BASE_URL,
    }),
    env.ANTNEST_EDGE_PUBLIC_BASE_URL,
  );
  for (const url of [
    "http://127.0.0.1:43110",
    "https://antnest.example:8443",
    "http://edge-gateway.example:8080",
  ])
    assert.equal(gatewayOrigin(url, env), url);
  assert.equal(
    gatewayOrigin("http://edge-gateway:8080", {}),
    "http://edge-gateway:8080",
  );
});

test("container clients send the public Origin while retaining their private transport URL", async (t) => {
  const previous = process.env.TEST_GATEWAY_PUBLIC_URL;
  process.env.TEST_GATEWAY_PUBLIC_URL = "https://antnest.example:8443";
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_GATEWAY_PUBLIC_URL;
    else process.env.TEST_GATEWAY_PUBLIC_URL = previous;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, origin: options.headers.Origin });
    return new Response("{}", { status: 200 });
  });
  await new GatewayClient("http://edge-gateway:8080").request("/api/session");
  await new GatewayClient("http://127.0.0.1:43110").request("/api/session");
  assert.deepEqual(requests, [
    {
      url: "http://edge-gateway:8080/api/session",
      origin: "https://antnest.example:8443",
    },
    {
      url: "http://127.0.0.1:43110/api/session",
      origin: "http://127.0.0.1:43110",
    },
  ]);
});

test("Docker fixture clients receive the matching public origin without changing probe commands", () => {
  const environment = {
    ANTNEST_EDGE_PUBLIC_BASE_URL: "http://127.0.0.1:43110",
  };
  const args = ["run", "--rm", "node:24", "node", "/tests/client.mjs"];
  assert.deepEqual(dockerInvocation(args, 2000, 1000, environment).args, [
    "run",
    "--env",
    "TEST_GATEWAY_PUBLIC_URL=http://127.0.0.1:43110",
    ...args.slice(1),
  ]);
  assert.deepEqual(
    dockerInvocation(["inspect", "fixture"], 2000, 1000, environment).args,
    ["inspect", "fixture"],
  );
  assert.deepEqual(args, [
    "run",
    "--rm",
    "node:24",
    "node",
    "/tests/client.mjs",
  ]);
});

test("Docker origin injection covers create and lifecycle calls while retaining explicit overrides", () => {
  const env = { TEST_GATEWAY_PUBLIC_URL: "https://antnest.example" };
  for (const prefix of [["create"], ["--lifecycle", "run"]]) {
    const result = dockerInvocation(
      [...prefix, "--rm", "node:24"],
      91000,
      1000,
      env,
    );
    assert.deepEqual(result.args, [
      prefix.at(-1),
      "--env",
      "TEST_GATEWAY_PUBLIC_URL=https://antnest.example",
      "--rm",
      "node:24",
    ]);
    assert.equal(result.timeoutMs, prefix.length === 2 ? 90000 : 30000);
  }
  for (const explicit of [
    ["--env", "TEST_GATEWAY_PUBLIC_URL=https://explicit.example"],
    ["-e", "TEST_GATEWAY_PUBLIC_URL"],
    ["--env=TEST_GATEWAY_PUBLIC_URL=https://explicit.example"],
    ["-eTEST_GATEWAY_PUBLIC_URL=https://explicit.example"],
  ]) {
    const args = ["run", ...explicit, "node:24"];
    assert.deepEqual(dockerInvocation(args, 2000, 1000, env).args, args);
  }
});
