import { fileURLToPath } from "node:url";
import { runFoundation } from "../lifecycle-closeout/foundation-run.mjs";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
await runFoundation("workspace-browser");
