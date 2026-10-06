import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/runtime/managed-mcp.schema.json",
      import.meta.url,
    ),
  ),
);
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);
const write = ajv.compile({ $ref: schema.$id + "#/$defs/servers_write" });
const read = ajv.compile({ $ref: schema.$id + "#/$defs/servers_read" });
test("managed MCP contracts separate write-only values from read fingerprints", () => {
  const server = (secret) => [
    { id: "docs", command: "node", secret_env: { API_KEY: secret } },
  ];
  assert(write(server({ value: "synthetic-only" })));
  assert(write(server({ value: "" })));
  assert(write(server({ keep: true })));
  const fingerprint = "hmac-sha256:0123456789abcdef0123456789abcdef";
  assert(read(server({ set: true, fingerprint })));
  for (const invalid of [
    { value: "x", keep: true },
    { keep: false },
    {},
    { value: 1 },
    { set: true, fingerprint },
  ])
    assert(!write(server(invalid)));
  assert(!read(server({ value: "synthetic-only" })));
  assert(!read(server({ keep: true })));
  assert(!read(server({ set: false, fingerprint })));
  assert(!read(server({ set: true, fingerprint: "sha256:1234abcd" })));
  assert(
    !write([
      { id: "docs", command: "node", secret_env: { HOME: { value: "x" } } },
    ]),
  );
});

test("managed MCP cannot redirect private credential cache directories", () => {
  for (const name of [
    "HOME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    for (const field of ["env", "secret_env"]) {
      const value = field === "env" ? "/workspace" : { value: "/workspace" };
      assert(
        !write([{ id: "docs", command: "node", [field]: { [name]: value } }]),
        name,
      );
    }
  }
});
