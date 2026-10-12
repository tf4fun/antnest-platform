import assert from "node:assert/strict";
import { observeBoundedRevocation } from "../../support/bounded-revocation.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { assertNoStore } from "./support.mjs";
import { assertOrganizationSession } from "./organization-session.mjs";
import { workspaceFromBootstrap } from "../../../services/agent-ui/web/src/lib/bootstrap.ts";

// Persist every HTTP result before the bounded observer checks its status.
const observedStatuses = Array.from({ length: 500 }, (_, index) => index + 100);

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
          else workspaceFromBootstrap(response.body);
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
