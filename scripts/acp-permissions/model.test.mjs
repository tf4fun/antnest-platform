import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "./model.mjs";

test("judge fixture matches exact request identity and distinguishes mutating arguments", () => {
  const payload = {
    messages: [
      {
        role: "system",
        content: "Classify one tool call as strictly read-only.",
      },
      {
        role: "user",
        content: JSON.stringify({
          request_id: "c",
          arguments: { value: "v1-judge-safe" },
        }),
      },
    ],
  };
  assert.deepEqual(JSON.parse(decide(payload).text), {
    request_id: "c",
    read_only: true,
  });
  payload.messages[1].content = JSON.stringify({
    request_id: "different",
    arguments: { value: "v1-judge-ask" },
  });
  assert.deepEqual(JSON.parse(decide(payload).text), {
    request_id: "different",
    read_only: false,
  });
});
test("fixture requires actual results or explicit denial before final text", () => {
  const payload = { messages: [{ role: "user", content: "v1-once" }] };
  assert.equal(decide(payload).call.name, "write");
  payload.messages.push({
    role: "tool",
    content: "Tool was not executed: reject_once",
  });
  assert.throws(() => decide(payload));
  payload.messages[0].content = "v1-deny";
  assert.equal(decide(payload).text, "v1-deny verified");
  payload.messages[0].content = "v1-reject-follow";
  payload.messages[1].content =
    "Tool execution is disabled by the Session authorization policy.";
  assert.equal(decide(payload).text, "v1-reject-follow verified");
});

test("read-hint fixture requires a bounded read and actual file content", () => {
  const payload = { messages: [{ role: "user", content: "v1-read-hint" }] };
  assert.equal(decide(payload).call.arguments.limit, 1024);
  payload.messages.push({
    role: "tool",
    content: "Tool arguments do not match the declared schema",
  });
  assert.throws(() => decide(payload));
  payload.messages[1].content = JSON.stringify({
    content: "v1-once\n",
    truncated: false,
  });
  assert.equal(decide(payload).text, "v1-read-hint verified");
});
