import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { durablePath, readConfiguration } from "../storage.mjs";
const { values } = parseArgs({ options: { config: { type: "string" } } });
const config = readConfiguration(values.config);
const root = config.output;
const log = durablePath(config.inputLog);
assert(statSync(root).isDirectory(), "output must be an existing directory");
assert(
  typeof config.jaeger === "string" && config.jaeger.length,
  "jaeger URL is required",
);
let jaeger;
try {
  jaeger = new URL(config.jaeger);
} catch {
  throw new Error("jaeger must be an HTTP(S) URL");
}
assert(
  ["http:", "https:"].includes(jaeger.protocol) &&
    !jaeger.username &&
    !jaeger.password &&
    !jaeger.search &&
    !jaeger.hash,
  "jaeger must be an HTTP(S) URL without credentials, query or fragment",
);
const base = config.jaeger.replace(/\/$/, "");
await delay(6000);
const lines = (await readFile(log, "utf8")).split("\n");
const ids = new Set();
for (const line of lines) {
  try {
    const row = JSON.parse(line.slice(line.indexOf("{")));
    if (row.status_code === 500 && /^[a-f0-9]{32}$/.test(row.trace_id))
      ids.add(row.trace_id);
  } catch {}
}
for (const id of ids) {
  const output = durablePath(`${root}/identity-failure-${id}.private.json`);
  const r = await fetch(`${base}/api/traces/${id}`, {
    signal: AbortSignal.timeout(5000),
  });
  await writeFile(durablePath(output), await r.text(), { mode: 0o600 });
}
