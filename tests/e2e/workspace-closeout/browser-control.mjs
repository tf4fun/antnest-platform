import assert from "node:assert/strict";
import { note } from "./browser-model.mjs";

export function assertWorkspaceBytes(encoded) {
  assert(
    Buffer.from(encoded, "base64").toString() === note,
    "workspace write duplicated or lost",
  );
}
