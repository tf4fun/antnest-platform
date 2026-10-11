import assert from "node:assert/strict";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { runConsoleAcceptance } from "./run.mjs";

const evidence = fileURLToPath(
  new URL(
    "../../../../artifacts/verification/console-authentication/",
    import.meta.url,
  ),
);
const projects = () =>
  new Set(existsSync(evidence) ? readdirSync(evidence) : []);

for (const failure of ["root-user", "partial-credentials"]) {
  test(`Console ${failure} failure leaves no credentials and starts no Docker`, async (t) => {
    const before = projects();
    let children = 0;
    t.mock.method(childProcess, "spawn", () => {
      children++;
      throw Error("unexpected child process");
    });
    t.mock.method(process, "getuid", () => (failure === "root-user" ? 0 : 501));
    t.mock.method(crypto, "generateKeyPairSync", () => {
      throw Error("synthetic-key-failure");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runConsoleAcceptance(),
        failure === "root-user" ? /nonroot user/ : /synthetic-key-failure/,
      );
      assert.equal(children, 0);
      const created = [...projects()].filter((name) => !before.has(name));
      if (failure === "root-user")
        assert.deepEqual(
          created,
          [],
          "preconditions must run before writing credentials",
        );
      else
        for (const name of created)
          assert.equal(
            existsSync(join(evidence, name, "credentials")),
            false,
            "partial credentials must be removed",
          );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const name of projects())
        if (!before.has(name))
          rmSync(join(evidence, name), { recursive: true, force: true });
    }
  });
}
