import assert from "node:assert/strict";
import { test } from "node:test";
import { strictJson, strictObject } from "../src/adapters/strict-json.ts";

test("strict JSON preserves escaped strings, Unicode and nested values", () => {
  for (const value of [
    { empty: "", escaped: '\\"\n\t\\', unicode: "\u4e00\ud83d\udc1c", lone: "\ud800" },
    { nested: [{ quote: '"', slash: "\\", literal: "{\"same\":1,\"same\":2}" }], number: -1.25e30 },
    { attachment: "x".repeat(4 * 1024 * 1024) + '\\"' },
  ]) {
    assert.deepEqual(strictObject(Buffer.from(JSON.stringify(value))), value);
  }
  assert.deepEqual(strictJson('[true,false,null,0,-0,1.2e-3]'), [true, false, null, 0, -0, 1.2e-3]);
});

test("strict JSON rejects decoded duplicate keys at every nested depth", () => {
  for (const source of [
    '{"a":1,"\\u0061":2}',
    '{"outer":[{"a":1,"a":2}]}',
    '{"a\\\"b":1,"a\\u0022b":2}',
    '{"\\ud83d\\udc1c":1,"\ud83d\udc1c":2}',
    '{"__proto__":1,"__proto__":2}',
  ]) assert.throws(() => strictObject(source));
  assert.deepEqual(strictObject('{"a":{"same":1},"b":{"same":2}}'), { a: { same: 1 }, b: { same: 2 } });
});

test("strict JSON keeps native grammar and UTF-8 rejection after string scanning", () => {
  for (const source of [
    '{"a":"\\x"}', '{"a":"\\u123"}', '{"a":"unfinished\\"}',
    '{"a":"line\nbreak"}', '{"a":"nul\u0000byte"}',
    '{"a":"value" garbage}', '{"a":01}', '{"a":1.}', '{"a":+1}',
    '{"a":[1,]}', '{"a":1,}', '{"a":undefined}', '{}{}', '\ufeff{}',
  ]) assert.throws(() => strictObject(source));
  assert.throws(() => strictObject(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])));
  for (const source of ['[]', 'null', '1', '"text"']) assert.throws(() => strictObject(source));
  assert.throws(() => strictJson('['.repeat(66) + '0' + ']'.repeat(66)));
});
