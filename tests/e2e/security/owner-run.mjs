import { fileURLToPath } from "node:url";
import { runAuthenticationMatrix } from "./run.mjs";

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
console.log(
  JSON.stringify(await runAuthenticationMatrix({ ownerProfile: true })),
);
