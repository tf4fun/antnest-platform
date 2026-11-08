import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const json = (path) => JSON.parse(read(path));

test("Identity publishes directory methods with their producer registration", () => {
  const active = json("contracts/identity/identity-contract.json");
  const source = read("services/identity-service/internal/rpc/handler.go");
  for (const [name, path] of [
    ["list_members", "/list-members"],
    ["list_groups", "/list-groups"],
  ]) {
    const registered = source.includes(
      `HandleFunc("POST /rpc/identity${path}"`,
    );
    assert.equal(name in active.methods, registered, name);
  }
  assert.equal(active.revision, active.methods.list_members ? 20 : 18);
});

test("Console publishes directory pages with their producer registration", () => {
  const active = json("contracts/admin-console/admin-contract.json");
  const source = read("services/admin-console/internal/server/handler.go");
  for (const [name, path] of [
    ["directory_members", "/directory/members"],
    ["directory_groups", "/directory/groups"],
  ]) {
    const registered = source.includes(`HandleFunc("GET /api/admin${path}"`);
    assert.equal(name in active.routes, registered, name);
  }
  assert.equal(active.version, active.routes.directory_members ? 62 : 60);
});
