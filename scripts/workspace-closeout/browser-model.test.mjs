import assert from "node:assert/strict";
import test from "node:test";
import { decide, note, imageData } from "./browser-model.mjs";

const payload = (content) => ({
  model: "stage3-model",
  tools: ["bash", "read"].map((name) => ({ function: { name } })),
  messages: [{ role: "user", content }],
});
const completed = (phase, result) => {
  const value = payload(phase);
  const { call } = decide(value);
  value.messages.push(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `${phase}-tool`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: `${phase}-tool`,
      content: JSON.stringify({
        effect_state: "settled",
        truncated: false,
        ...result,
      }),
    },
  );
  return value;
};
const uploads = () => [
  { type: "text", text: "c4-browser-attachments" },
  {
    type: "text",
    text: `Embedded resource: attachment:///workspace-notes.md\n${note}`,
  },
  {
    type: "image_url",
    image_url: { url: `data:image/png;base64,${imageData}` },
  },
];

test("browser model requires real advertised tools and exact read results", () => {
  assert.equal(decide(payload("c4-browser-write")).call.name, "bash");
  assert.equal(decide(payload("c4-browser-read")).call.name, "read");
  assert.match(
    decide(completed("c4-browser-read", { content: note })).text,
    /alpha-beta/,
  );
  assert.throws(() => decide({ ...payload("c4-browser-read"), tools: [] }));
  assert.throws(() =>
    decide(completed("c4-browser-read", { content: "wrong" })),
  );
});

test("browser model accepts exact attachments and rejects missing or changed bytes", () => {
  assert.match(decide(payload(uploads())).text, /image verified/);
  assert.throws(() => decide(payload(uploads().slice(0, 2))));
  const changed = uploads();
  changed[2].image_url.url += "A";
  assert.throws(() => decide(payload(changed)));
  changed[2] = uploads()[2];
  changed[1].text += "changed";
  assert.throws(() => decide(payload(changed)));
});

test("browser model cannot pass an unknown prompt or duplicate tool result", () => {
  assert.throws(() => decide(payload("unexpected")));
  assert.throws(() =>
    decide(
      completed("c4-browser-write", {
        exit_code: 1,
        stdout: "workspace-written\n",
        stderr: "failed",
      }),
    ),
  );
  const repeated = completed("c4-browser-read", { content: note });
  repeated.messages.push(repeated.messages.at(-1));
  assert.throws(() => decide(repeated));
  assert.equal(
    decide(payload("c4-browser-mobile")).text,
    "Mobile conversation ready.",
  );
});

test("Tool results must match the issued call and never appear in no-Tool phases", () => {
  const orphan = payload("c4-browser-read");
  orphan.messages.push({
    role: "tool",
    tool_call_id: "c4-browser-read-tool",
    content: JSON.stringify({ content: note }),
  });
  assert.throws(() => decide(orphan));
  const wrongID = completed("c4-browser-read", { content: note });
  wrongID.messages.at(-1).tool_call_id = "foreign";
  assert.throws(() => decide(wrongID));
  const wrongCall = completed("c4-browser-read", { content: note });
  wrongCall.messages[1].tool_calls[0].function.name = "bash";
  assert.throws(() => decide(wrongCall));
  for (const prompt of [uploads(), "c4-browser-mobile"]) {
    const value = payload(prompt);
    value.messages.push({ role: "tool", content: "unexpected" });
    assert.throws(() => decide(value));
  }
  assert.match(
    decide(
      completed("c4-browser-write", {
        exit_code: 0,
        stdout: "workspace-written\n",
        stderr: "",
      }),
    ).text,
    /saved/,
  );
});
