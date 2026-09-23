import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./restore-model.mjs";

const payload = (phase) => ({
  model: "stage3-model",
  tools: [{ function: { name: "bash" } }, { function: { name: "read" } }],
  messages: [{ role: "user", content: phase }],
});

test("backup fixture requires an actual append before backup and exact read after restore", () => {
  assert.equal(decide(payload("c5-before-backup")).call.name, "bash");
  assert.equal(decide(payload("c5-after-restore")).call.name, "read");
  for (const phase of ["c5-before-backup", "c5-after-restore"]) {
    const input = payload(phase);
    input.messages.push({
      role: "tool",
      content:
        phase === "c5-before-backup"
          ? "backup-written"
          : JSON.stringify({ content: "before-backup\n" }),
    });
    assert.equal(decide(input).text, `${phase} completed`);
    input.messages.push(input.messages.at(-1));
    assert.throws(() => decide(input));
  }
});

test("restore fixture cannot accept replayed writes, missing tools or changed file contents", () => {
  assert.throws(() => decide(payload("unknown")));
  assert.throws(() => decide({ ...payload("c5-before-backup"), tools: [] }));
  for (const content of ["", "before-backup\nbefore-backup\n", "changed"]) {
    const input = payload("c5-after-restore");
    input.messages.push({ role: "tool", content: JSON.stringify({ content }) });
    assert.throws(() => decide(input));
  }
});
