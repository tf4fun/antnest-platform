import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const profile = process.argv[2] ?? "foundation";
assert(
  [
    "foundation",
    "network",
    "health",
    "restore",
    "skill-restore",
    "loss",
    "shutdown",
  ].includes(profile) && process.argv.length <= 3,
);

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const { runFoundation } = await import("./foundation-run.mjs");
await runFoundation(profile, {
  runtimeImage: process.env.ANTNEST_E2E_RUNTIME_IMAGE,
  candidateTag: process.env.ANTNEST_E2E_CANDIDATE_TAG,
});
