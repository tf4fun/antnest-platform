import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const SHARED_PIN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../tests/support/shared-versions.json", import.meta.url)),
    "utf8",
  ),
)["@agentclientprotocol/sdk"];
const moduleURL = new URL("./audit-sdk.mjs", import.meta.url);
const implementation = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    (error.url !== moduleURL.href && !error.message.includes(moduleURL.pathname))
  )
    throw error;
  return {};
});

const ENTRYPOINTS = [
  "root",
  "v1-unstable",
  "v2",
  "v2-unstable",
  "http-client",
  "ws-client",
  "server",
  "node",
];
const KNOWN_RUNTIME_EXPORTS = {
  root: "ndJsonStream",
  "v1-unstable": "agent",
  v2: "agent",
  "v2-unstable": "agent",
  "http-client": "createHttpStream",
  "ws-client": "createWebSocketStream",
  server: "AcpServer",
  node: "createNodeHttpHandler",
};

function api(name) {
  assert.equal(typeof implementation[name], "function", `${name} is exported`);
  return implementation[name];
}

async function surface() {
  const collected = await api("collectSdkSurface")();
  return JSON.parse(JSON.stringify(collected));
}

test("the collected surface records the installed SDK version and public shape", async () => {
  const actual = await surface();
  const manifest = JSON.parse(
    readFileSync(join(serviceRoot, "node_modules/@agentclientprotocol/sdk/package.json"), "utf8"),
  );
  const schemaHash = (relative) =>
    createHash("sha256")
      .update(readFileSync(join(serviceRoot, relative)))
      .digest("hex");
  assert.equal(actual.sdkVersion, SHARED_PIN);
  assert.equal(actual.sdkVersion, manifest.version);
  assert.deepEqual(actual.exports, manifest.exports);
  assert.equal(
    actual.schemaSha256.v1,
    schemaHash("node_modules/@agentclientprotocol/sdk/schema/v1/schema.unstable.json"),
  );
  assert.equal(
    actual.schemaSha256.v2,
    schemaHash("node_modules/@agentclientprotocol/sdk/schema/v2/schema.unstable.json"),
  );
  assert.deepEqual(Object.keys(actual.runtimeExports).sort(), [...ENTRYPOINTS].sort());
  for (const entrypoint of ENTRYPOINTS) {
    const symbols = actual.runtimeExports[entrypoint];
    assert.deepEqual(symbols, [...symbols].sort(), `${entrypoint} exports sorted`);
    for (const symbol of symbols)
      assert.equal(typeof symbol, "string", `${entrypoint} symbol ${symbol}`);
    assert(
      symbols.includes(KNOWN_RUNTIME_EXPORTS[entrypoint]),
      `${entrypoint} exports ${KNOWN_RUNTIME_EXPORTS[entrypoint]}`,
    );
  }
});

test("matching surfaces compare clean regardless of key order", async () => {
  const actual = await surface();
  const check = api("checkSdkSurface");
  assert.deepEqual(check(actual, actual), []);
  assert.deepEqual(check(actual, structuredClone(actual)), []);
  const reordered = {
    schemaSha256: {
      v2: actual.schemaSha256.v2,
      v1: actual.schemaSha256.v1,
    },
    sdkVersion: actual.sdkVersion,
    runtimeExports: Object.fromEntries(Object.entries(actual.runtimeExports).reverse()),
    exports: Object.fromEntries(
      Object.entries(actual.exports)
        .reverse()
        .map(([key, value]) => [
          key,
          typeof value === "object" && value !== null
            ? Object.fromEntries(Object.entries(value).reverse())
            : value,
        ]),
    ),
  };
  assert.deepEqual(check(actual, reordered), []);
  assert.deepEqual(check(reordered, actual), []);
});

test("surface drift in any field is reported", async () => {
  const actual = await surface();
  const check = api("checkSdkSurface");
  const mutations = {
    "SDK version": (expected) => {
      expected.sdkVersion = "0.0.0";
    },
    "changed export map entry": (expected) => {
      expected.exports["./experimental/server"].import = "./dist/changed.js";
    },
    "removed export map entry": (expected) => {
      delete expected.exports["./experimental/v2"];
    },
    "added export map entry": (expected) => {
      expected.exports["./phantom-entry"] = "./dist/phantom.js";
    },
    "runtime export list": (expected) => {
      expected.runtimeExports.v2 = expected.runtimeExports.v2.filter(
        (symbol) => symbol !== "agent",
      );
    },
    "stable schema hash": (expected) => {
      expected.schemaSha256.v1 = "0".repeat(64);
    },
    "draft schema hash": (expected) => {
      expected.schemaSha256.v2 = "0".repeat(64);
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const expected = structuredClone(actual);
    mutate(expected);
    assert.notEqual(check(actual, expected).length, 0, label);
  }
});
