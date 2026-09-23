import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { assertWorkspaceBytes } from "./browser-control.mjs";

test("workspace mismatch fails without exposing actual bytes in error output", () => {
  const secret = "PRIVATE_FILE_CONTENT";
  assert.throws(
    () => assertWorkspaceBytes(Buffer.from(secret).toString("base64")),
    (error) => {
      assert(!inspect(error).includes(secret));
      return /workspace write duplicated or lost/.test(error.message);
    },
  );
  assertWorkspaceBytes(
    Buffer.from("C4_BROWSER_NOTE=alpha-beta\n").toString("base64"),
  );
});
