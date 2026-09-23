import assert from "node:assert/strict";
import { assertCatalog } from "../acp-commands/evidence.mjs";

// Compare one ordered wire timeline, not separate message/Tool subsequences.
export function assertMessageReplay(replayed, persisted, version) {
  const catalogs = replayed.filter(
    ({ update }) => update.sessionUpdate === "available_commands_update",
  );
  assertCatalog(replayed, catalogs[0]?.sessionId);
  const expected = persisted
    .filter((item) => item.visible && item.kind !== "state")
    .flatMap(({ payload: event }) => {
      if (
        ["user_message", "agent_message", "agent_thought"].includes(event.kind)
      ) {
        const type = version === 1 ? `${event.kind}_chunk` : event.kind;
        const chunks = version === 1 ? event.content : [event.content];
        return chunks.map((content) => [type, event.messageId, content]);
      }
      if (event.kind === "tool_call")
        return [
          [
            version === 1 && event.initial ? "tool_call" : "tool_call_update",
            event.toolCallId,
            event.status,
            event.argumentsJson === undefined
              ? null
              : JSON.parse(event.argumentsJson),
            event.content ?? null,
          ],
        ];
      assert.equal(event.kind, "usage", "unexpected durable visible event");
      return [["usage_update", event.used, event.size]];
    });
  const actual = replayed
    .filter(
      ({ update }) => update.sessionUpdate !== "available_commands_update",
    )
    .map(({ update }) => {
      if (update.messageId)
        return [update.sessionUpdate, update.messageId, update.content];
      if (update.toolCallId)
        return [
          update.sessionUpdate,
          update.toolCallId,
          update.status,
          update.rawInput ?? null,
          update.content?.map((item) => item.content) ?? null,
        ];
      return [update.sessionUpdate, update.used, update.size];
    });
  assert.deepEqual(
    actual,
    expected,
    "missing, duplicated, mistyped or reordered history",
  );
}
