import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/agent-acp/owner-assignment-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("fixed Agent assignment retains the full membership and legacy exclusion", () => {
  assert.equal(contract.version, 1);
  assert.equal(contract.status, "planned");
  assert.equal(contract.algorithm, "sha256-json-scope-mod-v1");
  assert.deepEqual(contract.member_count, { minimum: 1, maximum: 64 });
  assert.deepEqual(contract.lock, {
    key: 2026083002,
    legacy: "exclusive",
    registered_peer: "shared",
    fenced_legacy_required: true,
  });
  assert.equal(
    contract.missing_members,
    "retain in catalog and assignment; no implicit failover",
  );
});

for (const vector of contract.vectors) {
  test(`fixed assignment vector ${JSON.stringify([vector.organization_id, vector.agent_id])}`, () => {
    const digest = createHash("sha256")
      .update(JSON.stringify([vector.organization_id, vector.agent_id]), "utf8")
      .digest("hex");
    assert.equal(digest, vector.scope_sha256);
    const members = [...vector.members].sort();
    assert.equal(
      members[Number(BigInt(`0x${digest}`) % BigInt(members.length))],
      vector.preferred_member,
    );
  });
}
