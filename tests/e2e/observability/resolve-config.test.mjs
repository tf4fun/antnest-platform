import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import {
  resolveObservationConfig,
  offlineResolveConfig,
  requireResolveEvidenceDirectory,
} from "./resolve-config.mjs";

const read = (ttl, capture = "false") =>
  resolveObservationConfig(
    {
      ANTNEST_EDGE_RESOLVE_CACHE_TTL: ttl,
      ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: capture,
    },
    {},
  );

test("Gateway Unicode whitespace is accepted for TTL, capture and empty defaults", () => {
  assert.deepEqual(read("\u008510s\u0085", "\u0085true\u0085"), {
    resolveTTLMS: 10000,
    captureRpcContent: true,
  });
  assert.deepEqual(read("\u0085", "\u0085"), {
    resolveTTLMS: 10000,
    captureRpcContent: false,
  });
});

for (const [ttl, capture] of [
  ["\uFEFF10s\uFEFF", "false"],
  ["\uFEFF", "false"],
  ["10s", "\uFEFFtrue\uFEFF"],
  ["10s", "\uFEFF"],
])
  test(`Gateway rejects the JavaScript-only BOM whitespace ${JSON.stringify([ttl, capture])}`, () => {
    assert.throws(() => read(ttl, capture), {
      name: "Error",
      message: "invalid observability Resolve configuration",
    });
  });

for (const [value, expected] of [
  [undefined, 10000],
  ["", 10000],
  [" \t", 10000],
  ["10s", 10000],
  ["0", 0],
  ["-0", 0],
  ["+0", 0],
  ["0s", 0],
  ["-0.1ns", 0],
  ["30s", 30000],
  ["0.5m", 30000],
  [".005h", 18000],
  ["1.s", 1000],
  ["1s250ms", 1250],
  ["+2s1ms", 2001],
  ["1ms2s", 2001],
  ["1ns", 0.000001],
  ["1us", 0.001],
  ["1µs", 0.001],
  ["1μs", 0.001],
  ["0.5ns0.5ns", 0],
  ["  1.5s  ", 1500],
  ["0002s", 2000],
  ["0.999999999999999999ns", 0.000001],
])
  test(`effective Resolve TTL follows Gateway duration semantics for ${String(value)}`, () => {
    assert.deepEqual(read(value), {
      resolveTTLMS: expected,
      captureRpcContent: false,
    });
  });

for (const value of [
  "-1ns",
  "30s1ns",
  "31s",
  "1m",
  "1e1s",
  "NaN",
  "Infinity",
  "10",
  "000",
  "0.0",
  ".s",
  "+",
  "1s 1ms",
  "1S",
  "1w",
  "1s-1ns",
  "9223372036854775808h",
])
  test(`invalid Gateway TTL ${value} rejects without echoing configuration`, () => {
    assert.throws(() => read(value), {
      name: "Error",
      message: "invalid observability Resolve configuration",
    });
  });

for (const [value, expected] of [
  [undefined, false],
  ["", false],
  ["false", false],
  ["FALSE", false],
  [" True ", true],
])
  test(`capture setting ${String(value)} matches the deployed services`, () => {
    assert.equal(read("10s", value).captureRpcContent, expected);
  });
for (const value of ["1", "yes", "private-config-canary"])
  test(`invalid capture setting is never inferred from observed spans: ${value}`, () => {
    assert.throws(() => read("10s", value), {
      name: "Error",
      message: "invalid observability Resolve configuration",
    });
  });

test("exported environment takes precedence over the selected Compose env file", () => {
  const settings = {
    ANTNEST_EDGE_RESOLVE_CACHE_TTL: "2s",
    ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
  };
  const environment = {
    ANTNEST_EDGE_RESOLVE_CACHE_TTL: "3s",
    ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "true",
  };
  assert.deepEqual(resolveObservationConfig(settings, environment), {
    resolveTTLMS: 3000,
    captureRpcContent: true,
  });
  environment.ANTNEST_EDGE_RESOLVE_CACHE_TTL = "";
  assert.equal(
    resolveObservationConfig(settings, environment).resolveTTLMS,
    10000,
  );
});

for (const capture of [true, false])
  for (const [text, value] of [
    ["0", 0],
    ["0.000001", 0.000001],
    ["1234.56789", 1234.56789],
    ["30000", 30000],
  ])
    test(`offline configuration requires explicit TTL ${text} and capture ${capture}`, () => {
      assert.deepEqual(
        offlineResolveConfig({
          "resolve-ttl-ms": text,
          "capture-rpc-content": capture,
        }),
        { resolveTTLMS: value, captureRpcContent: capture },
      );
    });
for (const options of [
  {},
  { "resolve-ttl-ms": "10000" },
  { "capture-rpc-content": false },
  { "resolve-ttl-ms": " ", "capture-rpc-content": true },
  { "resolve-ttl-ms": "0.0000001", "capture-rpc-content": false },
  { "resolve-ttl-ms": "30000.000001", "capture-rpc-content": false },
])
  test(`offline inspector rejects missing or invalid effective config ${JSON.stringify(options)}`, () => {
    assert.throws(() => offlineResolveConfig(options), {
      name: "Error",
      message: "invalid observability Resolve configuration",
    });
  });

test("durable Resolve directory is explicit and validated before a caller reads credentials", (t) => {
  const root = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-observability-config-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(
    requireResolveEvidenceDirectory(join(root, "raw")),
    resolve(root, "raw"),
  );
  const file = join(root, "file");
  writeFileSync(file, "configuration-placeholder");
  for (const invalid of [undefined, "", ".cache/raw", file])
    assert.throws(() => requireResolveEvidenceDirectory(invalid));
});
