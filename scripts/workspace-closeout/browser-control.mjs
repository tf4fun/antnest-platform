import assert from "node:assert/strict";
import { note } from "./browser-model.mjs";

export function assertWorkspaceBytes(encoded) {
  assert(
    Buffer.from(encoded, "base64").toString() === note,
    "workspace write duplicated or lost",
  );
}

export function waitForFinish(input, controller) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      input.off("line", onLine);
      input.off("close", onClose);
      controller.signal.removeEventListener("abort", onAbort);
      if (error) {
        controller.abort(error);
        reject(error);
      } else resolve();
    };
    const onLine = (line) =>
      settle(
        line.trim() === "finish"
          ? undefined
          : new Error("unexpected browser command"),
      );
    const onClose = () =>
      settle(new Error("browser input closed before finish"));
    const onAbort = () => settle(new Error("browser acceptance interrupted"));
    input.on("line", onLine);
    input.once("close", onClose);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
}
