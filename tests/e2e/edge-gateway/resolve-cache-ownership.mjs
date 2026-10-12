import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { durablePath } from "../../support/storage.mjs";

// Return ownership only after both candidates are known to be unused. The
// caller must not register a rejected path for failure output or cleanup.
export function cacheEvidencePaths(project, destination) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const credentialsDirectory = durablePath(
    `artifacts/verification/authenticated-e2e/${project}`,
  );
  const output = durablePath(
    destination ?? `artifacts/verification/${project}-resolve-cache`,
  );
  assert(
    !existsSync(credentialsDirectory),
    "credential directory already exists",
  );
  assert(!existsSync(output), "cache acceptance output already exists");
  return { credentialsDirectory, output };
}
