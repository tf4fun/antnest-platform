import { fileURLToPath } from "node:url";
import { runStage4StorageRestore } from "./restore-stage4-storage-run.mjs";
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
console.log(
  JSON.stringify(
    await runStage4StorageRestore({
      runtimeImage: process.env.ANTNEST_E2E_RUNTIME_IMAGE,
      candidateTag: process.env.ANTNEST_E2E_CANDIDATE_TAG,
    }),
  ),
);
