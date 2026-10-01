import assert from "node:assert/strict";

const artifactHex = process.env.ANTNEST_E2E_CANDIDATE_ARTIFACT_HEX;
const organizationId = process.env.ANTNEST_E2E_ORGANIZATION_ID;
const actorId = process.env.ANTNEST_E2E_ACTOR_ID;
const expectedContent = process.env.ANTNEST_E2E_CONTENT_DIGEST;
const expectedArtifact = process.env.ANTNEST_E2E_ARTIFACT_DIGEST;
const token = process.env.ANTNEST_E2E_REGISTRY_TOKEN;
assert(
  artifactHex &&
    organizationId &&
    actorId &&
    expectedContent &&
    expectedArtifact &&
    token,
);

const archive = Buffer.from(artifactHex, "hex");
assert.equal(archive.toString("hex"), artifactHex);
const form = new FormData();
form.set(
  "metadata",
  JSON.stringify({
    request_id: "learning-candidate-registry-acceptance",
    organization_id: organizationId,
    actor_id: actorId,
  }),
);
form.set("artifact", new Blob([archive]), "candidate.zip");
const response = await fetch("http://skill-registry:8080/internal/skills", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
const result = await response.json();
assert.equal(response.status, 201, JSON.stringify(result));
assert.equal(result.name, "fixture-procedure");
assert.equal(result.version, 1);
assert.equal(result.content_digest, expectedContent);
assert.equal(result.artifact_digest, expectedArtifact);
assert.equal(result.package_rules_version, 1);
console.log(
  JSON.stringify({
    status: "candidate_registry_accepted",
    name: result.name,
    contentDigest: result.content_digest,
    artifactDigest: result.artifact_digest,
  }),
);
