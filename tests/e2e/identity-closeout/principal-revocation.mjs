import assert from "node:assert/strict";
import { observeBoundedRevocation } from "../../support/bounded-revocation.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { assertNoStore } from "./support.mjs";
import { assertOrganizationSession } from "./organization-session.mjs";

// Persist every HTTP result before the bounded observer checks its status.
const observedStatuses = Array.from({ length: 500 }, (_, index) => index + 100);

// This deprecated Gateway DTO predates the active Agent UI display projection.
// Its Principal has only these three fields; it has no organization labels.
function assertLegacyBootstrap(payload) {
  assert.deepEqual(Object.keys(payload).sort(), ["agents", "principal"]);
  assert.deepEqual(Object.keys(payload.principal).sort(), [
    "administrator",
    "organization_id",
    "user_id",
  ]);
  for (const key of ["user_id", "organization_id"])
    assert(
      typeof payload.principal[key] === "string" &&
        payload.principal[key].length > 0,
    );
  assert.equal(typeof payload.principal.administrator, "boolean");
  assert(Array.isArray(payload.agents));
  const ids = new Set();
  for (const agent of payload.agents) {
    assert(
      Object.keys(agent).every((key) =>
        [
          "agent_id",
          "name",
          "lifecycle_state",
          "activation_state",
          "runtime_state",
        ].includes(key),
      ),
    );
    for (const key of ["agent_id", "name"])
      assert(typeof agent[key] === "string" && agent[key].length > 0);
    assert(
      ["not_created", "created", "deleted"].includes(agent.lifecycle_state),
    );
    assert(
      [
        "unknown",
        "waiting",
        "available",
        "unhealthy",
        "exited",
        "absent",
      ].includes(agent.runtime_state),
    );
    assert.equal(
      Object.hasOwn(agent, "activation_state"),
      agent.lifecycle_state === "created",
    );
    if (agent.lifecycle_state === "created")
      assert(["enabled", "disabled"].includes(agent.activation_state));
    assert(!ids.has(agent.agent_id));
    ids.add(agent.agent_id);
  }
}

// Only already-warm cross-service mutations use this observer. Local Gateway
// mutations and cold scopes keep their immediate rejection assertions.
export async function observePrincipalRevocation({
  client,
  principal,
  path = "/api/session",
  committedMS,
  ttlMS,
  name,
  directory = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
  record = () => {},
  ...timing
}) {
  assert(["/api/session", "/api/app/bootstrap"].includes(path));
  assert(
    principal &&
      typeof principal === "object" &&
      principal.user_id &&
      principal.organization_id,
  );
  assert(/^[a-z0-9][a-z0-9-]*$/u.test(name));
  const original = structuredClone(principal),
    cookie = client.cookie;
  assert(cookie, "original revocation Cookie required");
  directory = evidenceDirectory(directory);
  const evidence = {
    path,
    committedMS,
    ttlMS,
    principal: original,
    observations: [],
    complete: false,
  };
  const save = () => {
    if (directory)
      writeEvidenceFile(directory, `${name}.json`, JSON.stringify(evidence));
  };
  save();
  await observeBoundedRevocation({
    ...timing,
    committedMS,
    ttlMS,
    request: () =>
      client.request(path, {
        status: observedStatuses,
        headers: { Cookie: cookie },
      }),
    record: (item, response) => {
      const observed = {
        ...item,
        ...(response.status === 200
          ? { principal: response.body?.principal }
          : { code: response.body?.code }),
        cache_control: response.headers.get("cache-control"),
        set_cookie_count: response.headers.getSetCookie().length,
      };
      evidence.observations.push(observed);
      save();
      record(observed);
    },
    validate: (response) => {
      try {
        assertNoStore(response.headers);
        assert.equal(
          response.headers.getSetCookie().length,
          0,
          "passive revocation read wrote Cookie",
        );
        assert.equal(
          client.cookie,
          cookie,
          "revocation observer changed the original Cookie",
        );
        if (response.status === 401)
          assert.equal(response.body?.code, "unauthenticated");
        else {
          if (path === "/api/session")
            assertOrganizationSession(response.body, "session", {
              slug: original.organization_slug,
              name: original.organization_name,
            });
          else assertLegacyBootstrap(response.body);
          assert.deepEqual(
            response.body.principal,
            original,
            "revocation changed the original Principal",
          );
        }
      } catch {
        // Upstream bodies, headers and Cookie values stay in private evidence.
        throw new Error(
          "revocation response violated the original session contract",
        );
      }
    },
  });
  timing.signal?.throwIfAborted();
  evidence.complete = true;
  save();
  return evidence;
}
