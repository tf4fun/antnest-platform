import assert from "node:assert/strict";
import {
  applyAgentDelta,
  validAgentView,
} from "../../../services/agent-ui/web/server/src/protocol/agent-view-delta.ts";

// Consume real SSE frames, including deltas and authoritative slow-reader resets.
export function agentStreamObserver() {
  const decoder = new TextDecoder();
  let buffer = "";
  let view = null;
  const revisions = [];
  let resets = 0;
  return {
    get view() {
      return view;
    },
    get revisions() {
      return revisions;
    },
    get resets() {
      return resets;
    },
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "snapshot" || event.type === "reset") {
          assert.ok(
            validAgentView(event.view),
            "Invalid authoritative Agent View",
          );
          view = event.view;
          if (event.type === "reset") resets++;
        } else {
          assert.equal(event.type, "delta");
          assert.ok(view, "A delta needs an initial View");
          assert.equal(event.fromStreamRevision, revisions.at(-1));
          view = applyAgentDelta(view, event);
          assert.ok(view, "A continuous delta must apply atomically");
        }
        revisions.push(event.toStreamRevision);
      }
    },
  };
}

// Verify complete signed content paging independently of the browser reducer.
export async function readTurnContent(base, sessionId, turn, headers, signal) {
  const result = {
    prompt: [...turn.prompt],
    finalResponse: [...turn.finalResponse],
  };
  let cursor = turn.contentCursor;
  let fragment = null;
  const seen = new Set();
  while (cursor) {
    assert.equal(seen.has(cursor), false, "Content paging must advance");
    seen.add(cursor);
    const response = await fetch(
      `${base}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turn.turnId)}/content?cursor=${encodeURIComponent(cursor)}`,
      { headers, signal },
    );
    assert.equal(response.status, 200);
    const bytes = await response.arrayBuffer();
    assert.ok(
      bytes.byteLength <= 262144,
      "Content pages stay within the wire envelope",
    );
    const page = JSON.parse(new TextDecoder().decode(bytes));
    const target = result[page.section];
    assert.ok(target);
    if (page.fragment) {
      const part = page.fragment;
      assert.equal(part.blockIndex, target.length);
      fragment ??= {
        section: page.section,
        size: 0,
        total: part.totalBytes,
        chunks: [],
      };
      assert.equal(fragment.section, page.section);
      assert.equal(part.byteOffset, fragment.size);
      assert.equal(part.totalBytes, fragment.total);
      const chunk = Buffer.from(part.serializedBlockBase64, "base64");
      fragment.chunks.push(chunk);
      fragment.size += chunk.length;
      assert.ok(fragment.size <= fragment.total);
      if (fragment.size === fragment.total) {
        target.push(
          JSON.parse(Buffer.concat(fragment.chunks).toString("utf8")),
        );
        fragment = null;
      }
    } else {
      assert.equal(fragment, null);
      target.push(...page.items);
    }
    assert.equal(page.complete, page.nextCursor === null);
    cursor = page.nextCursor;
  }
  assert.equal(fragment, null);
  return result;
}
