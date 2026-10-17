import assert from "node:assert/strict";
import { until } from "../acp-closeout/wait.mjs";
import { assertApprovalPending } from "./expectations.mjs";

export async function cancelPermissionPrompt(client, version, sid) {
  const cancel = client.request(
    "prompt",
    {
      sessionId: sid,
      prompt: [{ type: "text", text: `v${version}-cancel` }],
    },
    120000,
  );
  const observedCancel = cancel.catch((error) => ({ error }));
  await until(() => client.pendingPermissions.length === 1, "cancel approval");
  assertApprovalPending(
    client.pendingPermissions[0].params,
    client.updates,
    sid,
    "allow_once",
  );
  await client.notify("cancel", { sessionId: sid });
  const cancelled = await observedCancel;
  if (Object.hasOwn(cancelled, "error")) throw cancelled.error;
  if (version === 1) assert.equal(cancelled.stopReason, "cancelled");
  else
    await until(
      () =>
        client.updates.some(
          (frame) =>
            frame.sessionId === sid &&
            frame.update.sessionUpdate === "state_update" &&
            frame.update.state === "idle" &&
            frame.update.stopReason === "cancelled",
        ),
      "cancel idle",
    );
  await until(
    () => client.pendingPermissions.length === 0,
    "cancelled approval removed",
  );
}
