import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { until } from "./offboarding-client.mjs";

// Only the coordinating shell operates Docker; the client requests named checkpoints.
export async function controllerCheckpoint(name) {
  assert(["controller-offline", "controller-online"].includes(name));
  await writeFile(`/coordination/${name}.request`, "requested\n");
  await until(async () => {
    try {
      await access(`/coordination/${name}.ack`);
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return false;
    }
  }, name);
}
