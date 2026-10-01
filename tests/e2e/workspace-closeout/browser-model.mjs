import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createLifecycleModel } from "../lifecycle-closeout/model.mjs";
import { imageData } from "../acp-multimodal/fixtures.mjs";

export { imageData };
export const note = "C4_BROWSER_NOTE=alpha-beta\n";

export function decide(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex((m) => m.role === "user");
  const content = payload.messages[index]?.content;
  const phase = Array.isArray(content) ? content[0]?.text : content;
  assert(
    [
      "c4-browser-write",
      "c4-browser-read",
      "c4-browser-attachments",
      "c4-browser-mobile",
    ].includes(phase),
    "unexpected browser prompt",
  );
  const tail = payload.messages.slice(index + 1);
  if (phase === "c4-browser-attachments") {
    assert.equal(tail.length, 0, "unexpected attachment Tool result");
    assert.deepEqual(content, [
      { type: "text", text: phase },
      {
        type: "text",
        text: `Embedded resource: attachment:///workspace-notes.md\n${note}`,
      },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${imageData}` },
      },
    ]);
    return {
      phase,
      text: "Attachment bytes and image verified. Note: alpha-beta.",
    };
  }
  if (phase === "c4-browser-mobile") {
    assert.equal(tail.length, 0, "unexpected mobile Tool result");
    return { phase, text: "Mobile conversation ready." };
  }
  const call = toolCall(phase);
  assert(payload.tools.some((tool) => tool.function.name === call.name));
  if (tail.length) {
    assert.equal(tail.length, 2, "expected one issued Tool call and result");
    assert.equal(tail[0].role, "assistant");
    // ACP scopes Provider call IDs to a Run before executing/persisting them.
    const callID = tail[0].tool_calls?.[0]?.id;
    assert.match(callID ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(tail[0].tool_calls, [
      {
        id: callID,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      },
    ]);
    assert.equal(tail[1].role, "tool");
    assert.equal(tail[1].tool_call_id, callID);
    const output = JSON.parse(tail[1].content);
    assert.equal(output.effect_state, "settled");
    assert.equal(output.truncated, false);
    if (phase === "c4-browser-write") {
      assert.equal(output.exit_code, 0);
      assert.equal(output.stdout, "workspace-written\n");
      assert.equal(output.stderr, "");
    } else assert.equal(output.content, note);
    return {
      phase,
      text:
        phase === "c4-browser-write"
          ? "Workspace note saved."
          : "Workspace note: alpha-beta.",
    };
  }
  return { phase, call };
}

function toolCall(phase) {
  return phase === "c4-browser-write"
    ? {
        name: "bash",
        arguments: {
          command:
            "printf 'C4_BROWSER_NOTE=alpha-beta\\n' >> /workspace/.c4-browser-note; printf 'workspace-written\\n'",
          working_dir: ".",
          timeout_ms: 10000,
        },
      }
    : {
        name: "read",
        arguments: {
          path: ".c4-browser-note",
          offset: 1,
          limit: 4096,
        },
      };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createLifecycleModel(decide).listen(8080, "0.0.0.0");
