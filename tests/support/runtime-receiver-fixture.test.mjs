import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeReceiver } from "./runtime-receiver-fixture.mjs";

test("native fixture delivers only receiver hashes in its bootstrap identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-native-receiver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "auth");
  const descriptor = createRuntimeReceiver(path);
  const raw = readFileSync(join(path, "callers.json"));
  assert.equal(
    descriptor.receiver_digest,
    "sha256:" + createHash("sha256").update(raw).digest("hex"),
  );
  assert.equal(descriptor.callers_file, "/run/antnest-auth/callers.json");
  assert.match(descriptor.connection_id, /^rci_[0-9a-f]{32}$/u);
  const headers = readFileSync(join(path, "mcp.headers"), "utf8");
  const token = headers.trim().split("Bearer ")[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert(!raw.toString().includes(token));
  assert(!JSON.stringify(descriptor).includes(token));
  assert.deepEqual(JSON.parse(raw)["agent-acp-service"], [
    "sha256:" + createHash("sha256").update(token).digest("hex"),
  ]);
  assert.equal(statSync(path).mode & 0o777, 0o700);
  for (const file of ["callers.json", "mcp.headers", "status.headers"])
    assert.equal(statSync(join(path, file)).mode & 0o777, 0o600);
  assert.throws(() => createRuntimeReceiver(path));
});
