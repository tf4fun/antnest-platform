import { test } from "node:test";
import assert from "node:assert/strict";
import { editMultiline, managedMCPInput } from "./managed-mcp.ts";

const draft = () => [{ id: "documents", command: "node", args: ["server.js", "two words", ""],
  env: [{ name: "TOKEN", value: "synthetic value" }, { name: "EMPTY", value: "" }] }];
const form = (value: unknown) => { const data = new FormData(); data.set("managed_mcp", JSON.stringify(value)); return data; };

test("managed MCP secret fields write values, preserve by keep and clear by omission", () => {
  const base = { id: "documents", command: "node", args: [], env: [] };
  for (const [secret_env, expected] of [
    [[{ name: "API_KEY", value: "new-private-canary" }], { API_KEY: { value: "new-private-canary" } }],
    [[{ name: "API_KEY", keep: true }], { API_KEY: { keep: true } }],
    [[{ name: "API_KEY", value: "" }], { API_KEY: { value: "" } }],
  ] as const) assert.deepEqual(managedMCPInput(form([{ ...base, secret_env }]))[0], { id: "documents", command: "node", args: [], env: {}, secret_env: expected });
  assert.deepEqual(managedMCPInput(form([{ ...base, secret_env: [] }]))[0], { id: "documents", command: "node", args: [], env: {} });
  assert.throws(() => managedMCPInput(form([{ ...base, env: [{ name: "API_KEY", value: "public" }], secret_env: [{ name: "API_KEY", value: "private" }] }])), /Duplicate environment/);
});

test("multiline edits preserve existing line endings and explicit empty values", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    assert.equal(editMultiline(`a${newline}b`, "a\nbc"), `a${newline}bc`);
    assert.equal(editMultiline(`a${newline}b`, "a\nb\nc"), `a${newline}b${newline}c`);
    assert.equal(editMultiline(`a${newline}b`, ""), "");
    assert.equal(editMultiline(`a${newline}b`, "a\nb"), `a${newline}b`);
  }
  assert.equal(editMultiline("a\r\nb\nc\rd", "xa\nb\nc\nd"), "xa\r\nb\nc\rd");
  assert.equal(editMultiline("", "hello\nworld"), "hello\nworld");
});

test("managed MCP preserves arguments and environment without shell parsing", () => {
  assert.deepEqual(managedMCPInput(form(draft())), [{ id: "documents", command: "node", args: ["server.js", "two words", ""], env: { TOKEN: "synthetic value", EMPTY: "" } }]);
  assert.deepEqual(managedMCPInput(form([])), []);
});

test("managed MCP reports duplicate and reserved identifiers", () => {
  assert.throws(() => managedMCPInput(form([...draft(), ...draft()])), /Duplicate server ID/);
  const duplicate = draft(); duplicate[0].env.push({ name: "TOKEN", value: "other" });
  assert.throws(() => managedMCPInput(form(duplicate)), /Duplicate environment variable/);
  for (const name of ["HOME", "PATH", "ANTNEST_RUNTIME_SPEC", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
    const reserved = draft(); reserved[0].env[0].name = name;
    assert.throws(() => managedMCPInput(form(reserved)), /reserved/);
  }
  for (const id of ["Bad Name", "a".repeat(17), ""]) {
    const bad = draft(); bad[0].id = id;
    assert.throws(() => managedMCPInput(form(bad)), /Server ID/);
  }
});

test("managed MCP bounds bootstrap input and accepts prototype-like env names", () => {
  assert.throws(() => managedMCPInput(form(Array.from({ length: 9 }, () => draft()[0]))), /8/);
  const long = draft(); long[0].command = "字".repeat(1400);
  assert.throws(() => managedMCPInput(form(long)), /4096/);
  const args = draft(); args[0].args = Array(65).fill("");
  assert.throws(() => managedMCPInput(form(args)), /64/);
  const nul = draft(); nul[0].args[0] = "bad\0value";
  assert.throws(() => managedMCPInput(form(nul)), /NUL/);
  const safe = draft(); safe[0].env = [{ name: "__proto__", value: "kept" }];
  assert.equal(Object.hasOwn(managedMCPInput(form(safe))[0].env, "__proto__"), true);
});
