import { fileURLToPath } from "node:url";
import { runFoundation } from "../lifecycle-closeout/foundation-run.mjs";
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
await runFoundation("workspace", {
  runtimeImage: process.env.ANTNEST_E2E_RUNTIME_IMAGE,
  candidateTag: process.env.ANTNEST_E2E_CANDIDATE_TAG,
});
