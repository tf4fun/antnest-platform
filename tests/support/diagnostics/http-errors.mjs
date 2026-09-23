import assert from "node:assert/strict";
import { subscribe } from "node:diagnostics_channel";
import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { durablePath, readConfiguration } from "../storage.mjs";

const config = readConfiguration(process.env.ANTNEST_HTTP_DIAGNOSTICS_CONFIG);
assert(
  typeof config.originPrefix === "string" && config.originPrefix.length,
  "originPrefix is required",
);
assert(
  typeof config.pathPrefix === "string" && config.pathPrefix.length,
  "pathPrefix is required",
);
assert(
  statSync(config.output).isDirectory(),
  "output must be an existing directory",
);
const output = durablePath(join(config.output, "http-errors.private.jsonl"));
subscribe("undici:request:error", ({ request, error }) => {
  try {
    const origin = String(request.origin);
    if (!origin.startsWith(config.originPrefix)) return;
    const path = String(request.path).split("?")[0];
    if (!path.startsWith(config.pathPrefix)) return;
    appendFileSync(
      durablePath(output),
      JSON.stringify({
        time: new Date().toISOString(),
        method: request.method,
        path,
        error: {
          name: error.name,
          code: error.code,
          message: error.message,
          cause: error.cause
            ? {
                name: error.cause.name,
                code: error.cause.code,
                message: error.cause.message,
              }
            : undefined,
        },
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {}
});
