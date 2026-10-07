import assert from "node:assert/strict";
import { serviceCalls } from "./service-calls.mjs";

const artifactHex = process.env.ANTNEST_E2E_CANDIDATE_ARTIFACT_HEX;
const organizationId = process.env.ANTNEST_E2E_ORGANIZATION_ID;
const expectedContent = process.env.ANTNEST_E2E_CONTENT_DIGEST;
const expectedArtifact = process.env.ANTNEST_E2E_ARTIFACT_DIGEST;
assert(artifactHex && organizationId && expectedContent && expectedArtifact);

const archive = Buffer.from(artifactHex, "hex");
assert.equal(archive.toString("hex"), artifactHex);
const response = await serviceCalls().registryUpload(
  {
    organization_slug: "stage3",
    email: "stage3-admin@example.com",
    password: "stage3-admin-password",
  },
  (admin) => {
    assert.equal(admin.organization_id, organizationId);
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        request_id: "learning-candidate-registry-acceptance",
        organization_id: organizationId,
        actor_id: admin.user_id,
      }),
    );
    form.set("artifact", new Blob([archive]), "candidate.zip");
    return form;
  },
);
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
