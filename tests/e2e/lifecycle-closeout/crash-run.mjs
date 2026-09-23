import { fileURLToPath } from "node:url";
import { runFoundation } from "./foundation-run.mjs";
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
await runFoundation("crash");
