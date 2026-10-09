import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { prepareEgressOwnership } from "../../../scripts/dev-egress-auth-owner.mjs";

function fixture(t) {
  const path = resolve(
    "artifacts/verification/egress-owner-test",
    randomUUID(),
  );
  mkdirSync(path + "/runtime-egress", { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  writeFileSync(path + "/runtime-egress/callers.json", "{}", { mode: 0o600 });
  writeFileSync(
    path + "/runtime-egress/tunnel-master.key",
    Buffer.alloc(32, 1),
    { mode: 0o600 },
  );
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("Egress bootstrap changes only two individual files in an isolated root helper", async (t) => {
  const path = fixture(t),
    calls = [];
  await prepareEgressOwnership(async (args) => {
    calls.push(args);
  }, path);
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[0], "run");
  assert(args.includes("--rm"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], "0:0");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--cap-add") + 1], "CHOWN");
  const mounts = args.filter((value) => value.startsWith("type=bind,"));
  assert.deepEqual(mounts, [
    `type=bind,src=${path}/runtime-egress/callers.json,dst=/auth/callers.json`,
    `type=bind,src=${path}/runtime-egress/tunnel-master.key,dst=/auth/tunnel-master.key`,
  ]);
  assert(!args.includes("--privileged"));
});

test("bootstrap rejects symlinks and loose file permissions before Docker", async (t) => {
  const path = fixture(t);
  let calls = 0;
  const invoke = async () => {
    calls++;
  };
  const key = path + "/runtime-egress/tunnel-master.key";
  chmodSync(key, 0o644);
  await assert.rejects(prepareEgressOwnership(invoke, path));
  assert.equal(calls, 0);
  rmSync(key);
  symlinkSync("callers.json", key);
  await assert.rejects(prepareEgressOwnership(invoke, path));
  assert.equal(calls, 0);
});
