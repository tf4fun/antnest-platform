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

test("native receiver delivers private generation keys with a public digest descriptor", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-native-tunnel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "auth");
  const descriptor = createRuntimeReceiver(path);
  assert(descriptor.tunnel, "missing authenticated transport bootstrap");
  const raw = readFileSync(join(path, "tunnel.json"));
  const keys = JSON.parse(raw);
  assert.equal(keys.key_id, descriptor.tunnel.key_id);
  assert.equal(
    descriptor.tunnel.keys_digest,
    "sha256:" + createHash("sha256").update(raw).digest("hex"),
  );
  assert(!JSON.stringify(descriptor).includes(keys.runtime_private_key));
  assert(!JSON.stringify(descriptor).includes(keys.preshared_key));
  assert.equal(statSync(join(path, "tunnel.json")).mode & 0o777, 0o600);
});
