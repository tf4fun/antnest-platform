import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Fixed, single-file ZIP fixtures keep the deployed client independent of Python.
const archives = [
  "UEsDBBQAAAAAAMesO13i9oP1VwAAAFcAAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogY29kZS1yZXZpZXcKZGVzY3JpcHRpb246IFJldmlldyBjb2RlCi0tLQpTdGFnZSA0IGltbXV0YWJsZSBwcmVzZXQgdmVyc2lvbiAxLgpQSwECFAMUAAAAAADHrDtd4vaD9VcAAABXAAAACAAAAAAAAAAAAAAAgAEAAAAAU0tJTEwubWRQSwUGAAAAAAEAAQA2AAAAfQAAAAAA",
  "UEsDBBQAAAAAAMesO127SMX3VwAAAFcAAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogY29kZS1yZXZpZXcKZGVzY3JpcHRpb246IFJldmlldyBjb2RlCi0tLQpTdGFnZSA0IGltbXV0YWJsZSBwcmVzZXQgdmVyc2lvbiAyLgpQSwECFAMUAAAAAADHrDtdu0jF91cAAABXAAAACAAAAAAAAAAAAAAAgAEAAAAAU0tJTEwubWRQSwUGAAAAAAEAAQA2AAAAfQAAAAAA",
];

export async function publishSkill(admin, version, skillId) {
  assert([1, 2].includes(version));
  const form = new FormData();
  if (version === 2) {
    assert(skillId);
    form.append("expected_version", "1");
  }
  form.append(
    "artifact",
    new Blob([Buffer.from(archives[version - 1], "base64")], {
      type: "application/zip",
    }),
    `code-review-v${version}.zip`,
  );
  const path =
    version === 1
      ? "/api/admin/skills"
      : `/api/admin/skills/${skillId}/versions`;
  const response = await fetch(admin.base + path, {
    method: "POST",
    headers: {
      Cookie: admin.cookie,
      Origin: admin.base,
      "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
      "Idempotency-Key": randomUUID(),
    },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 201, `Skill v${version} publish failed`);
  const skill = await response.json();
  assert.equal(skill.version, version);
  assert.equal(skill.name, "code-review");
  if (skillId) assert.equal(skill.skill_id, skillId);
  return skill;
}

export function assertFrozenSkill(template, skill) {
  assert.equal(template.skill_refs.length, 1);
  const frozen = template.skill_refs[0];
  for (const field of [
    "skill_id",
    "version",
    "name",
    "description",
    "artifact_digest",
    "content_digest",
    "artifact_size",
    "unpacked_size",
    "package_rules_version",
  ])
    assert.equal(frozen[field], skill[field], `Skill snapshot ${field} drift`);
  assert.match(template.skill_set_digest, /^sha256:[a-f0-9]{64}$/);
}
