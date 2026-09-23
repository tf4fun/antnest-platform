import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "./model.mjs";

const payload = (text) => ({
  model: "stage3-model",
  messages: [
    { role: "system", content: "Synthetic lifecycle test" },
    { role: "user", content: text },
  ],
  tools: [{ function: { name: "bash" } }, { function: { name: "read" } }],
});
test("fixture holds real tools, recognizes completed effects and requires rebuild context", () => {
  const first = decide(payload("c4-cancel"));
  assert.equal(first.call.name, "bash");
  assert.match(first.call.arguments.command, /\.c4-cancel-started/);
  const next = payload("c4-offline");
  next.messages.push({ role: "tool", content: "c4-offline-complete" });
  assert.equal(decide(next).text, "c4-offline completed");
  assert.throws(() => decide(payload("unexpected")));
  assert.throws(() => decide(payload("c4-rebuilt")));
  const rebuilt = payload("c4-rebuilt");
  rebuilt.messages[0].content += " isolated execution environment was rebuilt";
  assert.equal(decide(rebuilt).call.name, "read");
});
